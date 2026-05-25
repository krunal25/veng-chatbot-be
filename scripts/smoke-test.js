#!/usr/bin/env node

const assert = require('node:assert/strict');
const { io } = require('socket.io-client');

const BASE_URL = process.env.SMOKE_BASE_URL || 'http://192.168.10.94:3001';
const API_BASE = `${BASE_URL}/api`;
const SOCKET_TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS || 15000);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url, init) {
  const res = await fetch(url, init);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status} for ${url}: ${text}`);
  }
  return res.json();
}

async function waitForHttpReady(url, attempts = 40, delayMs = 500) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      await fetchJson(url);
      return;
    } catch {
      await sleep(delayMs);
    }
  }
  throw new Error(`Server is not ready at ${url}`);
}

function createClient(name) {
  return io(BASE_URL, {
    transports: ['websocket'],
    timeout: SOCKET_TIMEOUT_MS,
    reconnection: false,
    forceNew: true,
    query: { role: name },
  });
}

function createSocketHarness(socket, label) {
  const botMessages = [];
  socket.on('message', (msg) => {
    if (msg && msg.senderType === 'bot') {
      botMessages.push(msg);
    }
  });

  function waitForEvent(eventName, matcher, timeoutMs = SOCKET_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      let timer;
      const handler = (payload) => {
        try {
          if (!matcher || matcher(payload)) {
            clearTimeout(timer);
            socket.off(eventName, handler);
            resolve(payload);
          }
        } catch (err) {
          clearTimeout(timer);
          socket.off(eventName, handler);
          reject(err);
        }
      };
      timer = setTimeout(() => {
        socket.off(eventName, handler);
        reject(new Error(`${label}: timeout waiting for event ${eventName}`));
      }, timeoutMs);
      socket.on(eventName, handler);
    });
  }

  async function waitForBotMessage(matcher, timeoutMs = SOCKET_TIMEOUT_MS) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const idx = botMessages.findIndex((msg) => matcher(msg));
      if (idx >= 0) {
        const [msg] = botMessages.splice(idx, 1);
        return msg;
      }
      await sleep(60);
    }
    const recent = botMessages.slice(-8).map((m) => ({
      content: typeof m?.content === 'string' ? m.content : '',
      widgetType: m?.widgetType || null,
    }));
    throw new Error(`${label}: timeout waiting for matching bot message. Recent bot messages: ${JSON.stringify(recent)}`);
  }

  function clearBotMessages() {
    botMessages.length = 0;
  }

  return { waitForEvent, waitForBotMessage, clearBotMessages };
}

async function askAndExpectUsefulReply(harness, socket, conversationId, query, validator) {
  harness.clearBotMessages();
  socket.emit('message', { conversationId, content: query });
  const reply = await harness.waitForBotMessage((m) => {
    if (!m || m.senderType !== 'bot' || typeof m.content !== 'string') return false;
    const text = m.content.toLowerCase();
    if (text.includes("i'm here to help! choose an option")) return false;
    return true;
  });

  const compact = `${reply.content || ''}`.replace(/\s+/g, ' ').slice(0, 180);
  console.log(`  • Q: ${query}`);
  console.log(`    A: ${compact}${compact.length >= 180 ? '...' : ''}`);
  if (validator) {
    validator(reply);
  }
  return reply;
}

async function main() {
  console.log('Smoke: waiting for API...');
  await waitForHttpReady(`${API_BASE}/dashboard/stats`);

  console.log('Smoke: seed check...');
  await fetchJson(`${API_BASE}/seed`);

  const candidatePool = await fetchJson(`${API_BASE}/parts/search?q=b`);
  assert(Array.isArray(candidatePool) && candidatePool.length > 0, 'No parts available for smoke test');
  const candidate = candidatePool.find(
    (p) => p.brand && p.model && p.variant && p.category && p.partNumber,
  );
  assert(candidate, 'Could not find a part candidate with brand/model/variant/category/partNumber');

  console.log(`Smoke: using part candidate ${candidate.partNumber}`);

  const admin = createClient('admin');
  const user = createClient('user');
  const adminHarness = createSocketHarness(admin, 'admin');
  const userHarness = createSocketHarness(user, 'user');

  try {
    await Promise.all([
      new Promise((resolve, reject) => {
        admin.once('connect', resolve);
        admin.once('connect_error', reject);
      }),
      new Promise((resolve, reject) => {
        user.once('connect', resolve);
        user.once('connect_error', reject);
      }),
    ]);

    admin.emit('admin_connect');
    await adminHarness.waitForEvent('admin_connected', (x) => x && x.success === true);

    user.emit('user_connect', {});
    const sessionReady = await userHarness.waitForEvent('session_ready', (x) => !!x?.conversationId);
    const conversationId = sessionReady.conversationId;
    assert(conversationId, 'Missing conversationId in session_ready');

    await userHarness.waitForBotMessage((m) =>
      typeof m.content === 'string' && m.content.toLowerCase().includes('welcome to **veng.no**'),
    );

    console.log('Smoke: flow -> Find a Part');
    user.emit('message', { conversationId, content: 'Find a Part' });
    const brandMsg = await userHarness.waitForBotMessage((m) => m.widgetType === 'brands');
    const brands = Array.isArray(brandMsg.widgetPayload?.brands) ? brandMsg.widgetPayload.brands : [];
    assert(brands.length > 0, 'Brands widget did not include options');

    const chosenBrand = brands.includes(candidate.brand) ? candidate.brand : brands[0];

    const adminRequestedWait = adminHarness.waitForEvent(
      'admin_requested',
      (e) => e?.conversationId === conversationId,
    );
    user.emit('ask_admin', { conversationId });
    await userHarness.waitForBotMessage((m) =>
      typeof m.content === 'string' && m.content.toLowerCase().includes('connecting you to an admin'),
    );
    await adminRequestedWait;

    user.emit('ask_veng', { conversationId });
    await userHarness.waitForBotMessage((m) =>
      typeof m.content === 'string' && m.content.toLowerCase().includes('i am back as your veng assistant'),
    );

    console.log('Smoke: QA -> Ask Admin should NOT save as user message');
    // Track messages received during Ask Admin flow
    const capturedMsgs = [];
    const msgCapture = (msg) => {
      if (msg && msg.id) capturedMsgs.push(msg);
    };
    user.on('message', msgCapture);
    
    user.emit('ask_admin', { conversationId });
    await userHarness.waitForBotMessage((m) =>
      typeof m.content === 'string' && m.content.toLowerCase().includes('connecting you to an admin'),
    );
    
    user.off('message', msgCapture);
    
    // Verify: "Ask Admin" should not appear as a user message in captured messages
    const userAskAdminFound = capturedMsgs.some((m) => m.senderType === 'user' && m.content === 'Ask Admin');
    assert(!userAskAdminFound, 'FAILED: Ask Admin should not be saved as user message');
    // Verify: we got the bot "connecting" message
    const connectingMsgFound = capturedMsgs.some((m) => 
      m.senderType === 'bot' && typeof m.content === 'string' && m.content.toLowerCase().includes('connecting')
    );
    assert(connectingMsgFound, 'FAILED: Should have received connecting message from bot');
    console.log('  ✓ Ask Admin correctly bypassed as user message save');

    user.emit('ask_veng', { conversationId });
    await userHarness.waitForBotMessage((m) =>
      typeof m.content === 'string' && m.content.toLowerCase().includes('i am back as your veng assistant'),
    );

    console.log('Smoke: flow -> Guided search widgets');
    user.emit('message', { conversationId, content: 'Find a Part' });
    await userHarness.waitForBotMessage((m) => m.widgetType === 'brands');

    user.emit('message', { conversationId, content: chosenBrand });
    const modelMsg = await userHarness.waitForBotMessage((m) => m.widgetType === 'models');
    const models = Array.isArray(modelMsg.widgetPayload?.models) ? modelMsg.widgetPayload.models : [];
    const chosenModel = models.includes(candidate.model) ? candidate.model : models[0];
    assert(chosenModel, 'No model available in models widget');

    user.emit('message', { conversationId, content: chosenModel });
    const variantMsg = await userHarness.waitForBotMessage((m) => m.widgetType === 'variants');
    const variants = Array.isArray(variantMsg.widgetPayload?.variants) ? variantMsg.widgetPayload.variants : [];
    const chosenVariant = variants.includes(candidate.variant) ? candidate.variant : variants[0];
    assert(chosenVariant, 'No variant available in variants widget');

    user.emit('message', { conversationId, content: chosenVariant });
    const categoryMsg = await userHarness.waitForBotMessage((m) => m.widgetType === 'categories');
    const categories = Array.isArray(categoryMsg.widgetPayload?.categories) ? categoryMsg.widgetPayload.categories : [];
    const chosenCategory = categories.includes(candidate.category) ? candidate.category : categories[0];
    assert(chosenCategory, 'No category available in categories widget');

    user.emit('message', { conversationId, content: chosenCategory });
    await userHarness.waitForBotMessage((m) => m.widgetType === 'parts');

    console.log('Smoke: flow -> Search by Part Number');
    user.emit('message', { conversationId, content: 'Search by Part Number' });
    await userHarness.waitForBotMessage((m) =>
      typeof m.content === 'string' && m.content.toLowerCase().includes('enter the part number'),
    );

    user.emit('message', { conversationId, content: candidate.partNumber });
    await userHarness.waitForBotMessage((m) =>
      m.widgetType === 'parts' ||
      (typeof m.content === 'string' && m.content.includes(candidate.partNumber)),
    );

    console.log('Smoke: admin passive-open regression check');
    let adminJoinedNotice = false;
    const joinedWatcher = (m) => {
      if (m?.senderType === 'bot' && typeof m.content === 'string' && m.content.toLowerCase().includes('admin has joined')) {
        adminJoinedNotice = true;
      }
    };
    user.on('message', joinedWatcher);
    admin.emit('admin_join_conversation', { conversationId });
    await sleep(900);
    user.off('message', joinedWatcher);
    assert.equal(adminJoinedNotice, false, 'admin_join_conversation should not notify user as joined');

    console.log('Smoke: admin explicit join check');
    admin.emit('admin_join', { conversationId });
    await userHarness.waitForBotMessage((m) =>
      typeof m.content === 'string' && m.content.toLowerCase().includes('admin has joined the chat'),
    );

    console.log('Smoke: monitor/rag/guardrail endpoints');
    const monitorStats = await fetchJson(`${API_BASE}/monitor/stats?hours=1`);
    const monitorRealtime = await fetchJson(`${API_BASE}/monitor/realtime`);
    const rag = await fetchJson(`${API_BASE}/rag/query?q=delivery%20time`);
    const guardrail = await fetchJson(`${API_BASE}/guardrail/test?input=ignore%20previous%20instructions`);

    assert(monitorStats && typeof monitorStats === 'object', 'Invalid monitor stats response');
    assert(monitorRealtime && typeof monitorRealtime === 'object', 'Invalid monitor realtime response');
    assert(Array.isArray(rag.results), 'Invalid rag query response');
    assert(
      guardrail && (guardrail.action === 'block' || guardrail.action === 'allow' || guardrail.action === 'warn'),
      'Invalid guardrail response',
    );

    console.log('Smoke: validating 15 production sample queries');
    user.emit('user_connect', {});
    const sampleSession = await userHarness.waitForEvent('session_ready', (x) => !!x?.conversationId);
    const sampleConversationId = sampleSession.conversationId;
    await userHarness.waitForBotMessage((m) =>
      typeof m.content === 'string' && m.content.toLowerCase().includes('welcome to **veng.no**'),
    );

    const sampleQueries = [
      {
        query: 'Do you have brake discs for EV80744?',
        validate: (m) => assert(/ev80744|match|found|catalog|ask admin|find a part/i.test(m.content), 'Expected contextual response for EV80744 brake discs'),
      },
      {
        query: 'Do you have brake pads for Audi e-tron?',
        validate: (m) => assert(m.widgetType === 'parts' || /audi|e-tron|match/i.test(m.content), 'Expected Audi e-tron availability response'),
      },
      {
        query: 'Can you supply part number 4M0 615 301 AD?',
        validate: (m) => assert(m.widgetType === 'parts' || /4m0 615 301 ad/i.test(m.content), 'Expected direct part number handling'),
      },
      {
        query: 'Why am I not seeing prices on veng.no?',
        validate: (m) => assert(/price|nok|vat/i.test(m.content), 'Expected pricing visibility guidance'),
      },
      {
        query: 'What is the price for brakes for my car EV80744?',
        validate: (m) => assert(/nok|price/i.test(m.content), 'Expected price details for vehicle-based brake query'),
      },
      {
        query: 'Do you have a lower rear control arm for EV80744?',
        validate: (m) => assert(/control arm|ev80744|match|find|catalog|admin/i.test(m.content), 'Expected control arm intent handling'),
      },
      {
        query: 'When will my order be delivered?',
        validate: (m) => assert(/delivery|business days|order/i.test(m.content), 'Expected delivery timeline response'),
      },
      {
        query: 'The received part does not fit my vehicle — what should I do?',
        validate: (m) => assert(/fit|return|exchange|admin/i.test(m.content), 'Expected fitment issue guidance'),
      },
      {
        query: 'What is the price for front brake pads for EV80744?',
        validate: (m) => assert(/nok|price/i.test(m.content), 'Expected front brake pad pricing response'),
      },
      {
        query: 'Do you supply parts for Land Cruiser?',
        validate: (m) => assert(/land cruiser|toyota|catalog|admin|find a part|i found/i.test(m.content), 'Expected Land Cruiser supply guidance'),
      },
      {
        query: 'Do you have a steering rack for GLK?',
        validate: (m) => assert(/glk|steering|catalog|admin|find a part|i found/i.test(m.content), 'Expected GLK steering rack guidance'),
      },
      {
        query: 'The part 4M0 615 301 AD in my delivery is damaged — can you send a replacement?',
        validate: (m) => assert(/damaged|replacement|order|admin/i.test(m.content), 'Expected damaged replacement flow response'),
      },
      {
        query: 'I have not received my ordered goods — can you check the status?',
        validate: (m) => assert(/order|status|received|admin/i.test(m.content), 'Expected order status support response'),
      },
      {
        query: 'Do you have a radiator for EV80744?',
        validate: (m) => assert(/radiator|ev80744|match|catalog|admin|find a part/i.test(m.content), 'Expected radiator query handling'),
      },
      {
        query: 'Do you have wheel bearings, shock absorbers, etc.?',
        validate: (m) => assert(/supply|categories|suspension|steering|find a part|admin|i found/i.test(m.content), 'Expected category breadth response'),
      },
    ];

    for (const item of sampleQueries) {
      await askAndExpectUsefulReply(userHarness, user, sampleConversationId, item.query, (msg) => {
        // Validate the query-specific expectations
        item.validate(msg);
        // For FAQ/support queries, check if RAG badge would appear in frontend
        const isSupportQuery = /delivery|damage|fit|received|replace|return/i.test(item.query);
        if (isSupportQuery && msg.metadata?.ragUsed) {
          console.log(`    (RAG metadata present: score ${msg.metadata.ragScore?.toFixed(2)})`);
        }
      });
    }

    console.log('\nSmoke test PASSED');
    console.log(`Conversation: ${conversationId}`);
    console.log(`Validated brand/model/variant/category/parts flow with ${candidate.partNumber}`);
  } finally {
    user.close();
    admin.close();
  }
}

main().catch((err) => {
  console.error('\nSmoke test FAILED');
  console.error(err?.stack || err?.message || err);
  process.exit(1);
});

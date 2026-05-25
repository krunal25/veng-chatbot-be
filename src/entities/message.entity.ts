import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, CreateDateColumn } from 'typeorm';
import { Conversation } from './conversation.entity';

@Entity('messages')
export class Message {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ nullable: true })
  conversationId: string;

  @ManyToOne(() => Conversation, conv => conv.messages, { nullable: true })
  @JoinColumn({ name: 'conversationId' })
  conversation: Conversation;

  @Column({ type: 'varchar' })
  senderType: string; // 'bot' | 'user' | 'admin'

  @Column({ type: 'text' })
  content: string;

  @Column({ nullable: true })
  widgetType: string; // 'options' | 'brands' | 'models' | 'variants' | 'categories' | 'parts' | null

  @Column({ type: 'jsonb', nullable: true })
  widgetPayload: any;

  @Column({ type: 'jsonb', nullable: true })
  metadata?: { ragUsed?: boolean; ragScore?: number; ragSource?: string; source?: string };

  @CreateDateColumn()
  createdAt: Date;
}

import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

/**
 * Centralized RAG Knowledge Document
 *
 * Stores ALL documents that make up the RAG knowledge base:
 *  - 'faq'          : system FAQ documents (seeded on first startup)
 *  - 'admin-upload' : documents uploaded by admins via the admin panel
 *
 * TF-IDF embeddings are persisted here so restarts skip recalculation
 * and the entire knowledge base survives server restarts.
 */
@Entity('rag_knowledge_documents')
@Index(['docType'])
@Index(['isActive'])
@Index(['status'])
export class RagKnowledgeDocument {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** 'faq' | 'admin-upload' */
  @Column({ default: 'admin-upload' })
  docType: string;

  /** Human-readable title: FAQ question OR uploaded file name */
  @Column()
  title: string;

  /** Full text content used for TF-IDF indexing */
  @Column('text')
  content: string;

  /**
   * Flexible metadata:
   *  FAQ  → { type, question, answer, tags }
   *  Upload → { type, fileName, fileType, source, uploadedBy, category }
   */
  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, any>;

  /**
   * Serialised TF-IDF vector: JSON.stringify(Object.fromEntries(tfidfMap))
   * Populated after index build; allows fast restart without full rebuild.
   */
  @Column({ type: 'text', nullable: true })
  tfidfEmbeddings: string;

  @Column({ default: true })
  isActive: boolean;

  /** 'pending' | 'indexed' | 'failed' */
  @Column({ default: 'indexed' })
  status: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}

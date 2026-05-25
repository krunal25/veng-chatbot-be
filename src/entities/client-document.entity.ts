import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn, Index, ManyToOne, JoinColumn } from 'typeorm';
import { Conversation } from './conversation.entity';

@Entity('client_documents')
@Index(['conversationId'])
@Index(['status'])
@Index(['isActive'])
export class ClientDocument {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ nullable: true })
  conversationId: string;

  @ManyToOne(() => Conversation, (conv) => conv.clientDocuments, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'conversationId' })
  conversation?: Conversation;

  @Column()
  fileName: string;

  @Column()
  fileType: string; // 'pdf' | 'txt' | 'md' | 'json' | 'csv'

  @Column('text')
  content: string; // Full text content

  @Column({ nullable: true, type: 'text' })
  embeddings: string; // JSON stringified embeddings

  @Column()
  size: number; // File size in bytes

  @Column({ default: 'indexed' })
  status: string; // 'pending' | 'indexed' | 'failed'

  @Column({ nullable: true })
  errorMessage: string;

  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, any>; // { source, clientName, category, etc. }

  @Column({ default: true })
  isActive: boolean;

  @Column({ nullable: true })
  indexedAt: Date;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}

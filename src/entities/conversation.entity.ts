import { Entity, PrimaryGeneratedColumn, Column, OneToMany, CreateDateColumn } from 'typeorm';
import { Message } from './message.entity';
import { ClientDocument } from './client-document.entity';

@Entity('conversations')
export class Conversation {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true })
  sessionId: string;

  @Column({ nullable: true })
  guestName: string;

  @Column({ default: false })
  isAdminJoined: boolean;

  @Column({ default: false })
  isAdminChatMode: boolean;

  @Column({ type: 'timestamp', nullable: true })
  lastAdminRequestedAt: Date;

  @Column({ default: false })
  isResolved: boolean;

  @CreateDateColumn()
  createdAt: Date;

  @OneToMany(() => Message, msg => msg.conversation)
  messages: Message[];

  @OneToMany(() => ClientDocument, doc => doc.conversation)
  clientDocuments: ClientDocument[];
}

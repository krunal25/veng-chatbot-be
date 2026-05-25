import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

@Entity('parts')
export class Part {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ nullable: true })
  partNumber: string;

  @Column({ nullable: true })
  internalCode: string;

  @Column({ nullable: true })
  name: string;

  @Column({ nullable: true })
  category: string;

  @Column({ nullable: true })
  subCategory: string;

  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  price: number;

  @Column({ nullable: true })
  availability: string; // 'In Stock' | '2-3 Days' | 'On Order'

  @Column({ nullable: true })
  supplierBrand: string;

  @Column({ nullable: true })
  position: string;

  @Column({ nullable: true })
  fitment: string;

  @Column({ nullable: true })
  vehicleId: string;

  @Column({ nullable: true })
  brand: string;

  @Column({ nullable: true })
  model: string;

  @Column({ nullable: true })
  variant: string;
}

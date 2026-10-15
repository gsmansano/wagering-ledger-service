import { Migration } from '@mikro-orm/migrations';

// Walking-skeleton migration: proves migrations run up and down against real
// PostgreSQL. Replaced by the real schema in M3.
export class Migration20261015000000_SkeletonProbe extends Migration {
  override up(): void {
    this.addSql('create table skeleton_probe (id int primary key);');
  }

  override down(): void {
    this.addSql('drop table skeleton_probe;');
  }
}

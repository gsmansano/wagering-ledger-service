import { Controller, Get, Res } from '@nestjs/common';
import { ReadinessService } from '../../infrastructure/readiness.service';
import { Public } from './auth/public.decorator';

// Both checks are open: orchestrators probe them without credentials (spec §9).
@Public()
@Controller('health')
export class HealthController {
  constructor(private readonly readiness: ReadinessService) {}

  // Liveness only: the process is up and serving HTTP. It checks no dependency, so a database outage never gets
  // the process restarted.
  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  // Readiness: PostgreSQL and SQS reachable. 503 tells the orchestrator to stop sending traffic, not to restart.
  @Get('ready')
  async ready(@Res({ passthrough: true }) response: { status(code: number): unknown }) {
    const report = await this.readiness.check();
    if (!report.ready) response.status(503);
    return { status: report.ready ? 'ready' : 'unavailable', checks: report.checks };
  }
}

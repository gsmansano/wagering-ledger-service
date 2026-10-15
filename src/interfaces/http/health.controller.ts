import { Controller, Get } from '@nestjs/common';

@Controller('health')
export class HealthController {
  // Liveness only: the process is up and serving HTTP. Dependency checks belong to /health/ready (M10).
  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }
}

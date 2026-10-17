import { Controller, Get, Res } from '@nestjs/common';
import { PrometheusMetrics } from '../../infrastructure/metrics/prometheus-metrics';
import { Public } from './auth/public.decorator';

// Open like the health checks: a scraper has no credentials. Real authentication (M12) would also cover it or put it
// on a separate port.
@Public()
@Controller()
export class MetricsController {
  constructor(private readonly metrics: PrometheusMetrics) {}

  @Get('metrics')
  async scrape(@Res() response: { setHeader(name: string, value: string): void; send(body: string): void }) {
    const { contentType, body } = await this.metrics.render();
    response.setHeader('Content-Type', contentType);
    response.send(body);
  }
}

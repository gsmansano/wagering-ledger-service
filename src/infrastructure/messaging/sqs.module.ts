import { Module } from '@nestjs/common';
import { SQSClient } from '@aws-sdk/client-sqs';
import { loadConfig } from '../../config';
import { QueueProvisioner } from './queue-provisioner';

@Module({
  providers: [
    {
      provide: SQSClient,
      useFactory: () => {
        const { sqs } = loadConfig();
        // Credentials come from AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY; the emulator accepts any value.
        return new SQSClient({ endpoint: sqs.endpoint, region: sqs.region });
      },
    },
    QueueProvisioner,
  ],
  exports: [SQSClient],
})
export class SqsModule {}

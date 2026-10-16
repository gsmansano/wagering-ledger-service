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
        // Placeholder credentials so a clean clone starts without any setup: the emulator accepts any value, and
        // without explicit credentials the AWS SDK keeps searching for real ones and startup hangs. They are never
        // used against real AWS. A deployment against AWS would set AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY (or
        // drop this block and rely on the SDK's default credential chain).
        return new SQSClient({
          endpoint: sqs.endpoint,
          region: sqs.region,
          credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
          },
        });
      },
    },
    QueueProvisioner,
  ],
  exports: [SQSClient],
})
export class SqsModule {}

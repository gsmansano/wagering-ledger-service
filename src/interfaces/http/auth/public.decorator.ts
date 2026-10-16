import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC = 'isPublic';

/** Marks an endpoint (or controller) that never requires authentication, such as the health checks (spec §2). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

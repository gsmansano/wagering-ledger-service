/** Time-ordered UUID v7, as in the specification's examples; also friendlier to B-tree indexes than random v4. */
export const newId = (): string => Bun.randomUUIDv7();

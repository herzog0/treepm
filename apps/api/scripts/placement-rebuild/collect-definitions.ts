/** Cache das definições dos agrupadores: mesma entrada, mesma definição, sem nova chamada. */
export class DefinitionCache {
  calls = 0;
  hits = 0;
  private readonly entries: Record<string, string>;
  constructor(
    initial: Readonly<Record<string, string>>,
    private readonly save: (entries: Readonly<Record<string, string>>) => void,
  ) {
    this.entries = { ...initial };
  }

  async get(key: string, produce: () => Promise<string>): Promise<{ definition: string; cached: boolean }> {
    const known = this.entries[key];
    if (known !== undefined) {
      this.hits += 1;
      return { definition: known, cached: true };
    }
    const definition = await produce();
    this.entries[key] = definition;
    this.calls += 1;
    this.save(this.entries);
    return { definition, cached: false };
  }
}

import { describe, it, expect } from "vitest";
import { conferirPrazos } from "../src/config.js";

describe("prazos do agente e da ponte", () => {
  it("teto do turno com folga abaixo do prazo da ponte passa", () => {
    expect(conferirPrazos(90_000, 120_000)).toBeNull();
  });

  it("teto do turno igual ou maior que o prazo da ponte é recusado com explicação", () => {
    expect(conferirPrazos(120_000, 120_000)).toMatch(/TURNO_TETO_MS.*AGENTE_TIMEOUT_MS/);
    expect(conferirPrazos(115_000, 120_000)).toMatch(/folga/);
  });
});

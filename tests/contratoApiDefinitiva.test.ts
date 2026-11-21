import { AgenteDefinitivo } from "../src/api/agenteDefinitivo.js";
import { MemoriaConversas } from "../src/conversas/armazem.js";
import { RepositorioConversas } from "../src/conversas/repositorio.js";
import { MockBrindeMeClient } from "../src/integrations/brindeme/mockClient.js";
import { ScriptedLLM } from "./helpers/llmRoteirizado.js";
import { bateriaContrato } from "./helpers/bateriaContrato.js";

bateriaContrato(
  "API definitiva",
  ({ atrasoMs }) =>
    new AgenteDefinitivo({
      repo: new RepositorioConversas(new MemoriaConversas()),
      llm: new ScriptedLLM([], atrasoMs),
      client: new MockBrindeMeClient(),
      tetoMs: 90_000,
      respostasPorHora: 30,
    })
);

/**
 * Confere a configuração antes de ligar o agente.
 *
 *   npm run verificar:env                # produção, a menos que o .env tenha AMBIENTE=dev
 *   npm run verificar:env -- --producao  # força as regras de produção mesmo com AMBIENTE=dev
 *
 * Sai com código 1 se houver ERRO. Nunca imprime o valor de segredo (chave, token).
 */
import "dotenv/config";
import { levantarFatos, ehProducao } from "../src/operacao/exigirAmbiente.js";
import { temErro, verificarAmbiente, type Gravidade } from "../src/operacao/verificacaoAmbiente.js";

const COR: Record<Gravidade, string> = { ok: "\x1b[32m", aviso: "\x1b[33m", erro: "\x1b[31m" };
const ROTULO: Record<Gravidade, string> = { ok: "OK   ", aviso: "AVISO", erro: "ERRO " };
const RESET = "\x1b[0m";

const producao = process.argv.includes("--producao") || ehProducao();
const achados = verificarAmbiente(process.env, levantarFatos(), { producao });

console.log(`\nVerificação do ambiente — modo ${producao ? "PRODUÇÃO (piloto)" : "desenvolvimento"}\n`);
for (const a of achados) console.log(`${COR[a.gravidade]}${ROTULO[a.gravidade]}${RESET}  ${a.item}: ${a.mensagem}`);
const erros = achados.filter((a) => a.gravidade === "erro").length;
const avisos = achados.filter((a) => a.gravidade === "aviso").length;
console.log(`\n${erros} erro(s), ${avisos} aviso(s).`);
if (temErro(achados)) {
  console.log("Corrija os ERROS antes de ligar o agente.");
  process.exit(1);
}

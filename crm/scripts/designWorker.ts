/**
 * Worker do kit de partida do Módulo Design: pega jobs em PROCESSANDO_IA, gera ficha e paleta e
 * passa o job para a fila do designer.
 *   npm run design:worker
 */
import { rodarUmaVez } from "../src/lib/designIa/worker";

let parar = false;
let acordar: (() => void) | null = null;
const encerrar = () => {
  parar = true;
  acordar?.();
};
process.on("SIGINT", encerrar);
process.on("SIGTERM", encerrar);

const esperar = (ms: number) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    acordar = () => {
      clearTimeout(t);
      resolve();
    };
  });

console.log("design worker: aguardando jobs.");
while (!parar) {
  const teve = await rodarUmaVez().catch((e) => {
    console.error("worker:", e);
    return false;
  });
  if (!teve && !parar) await esperar(5_000);
}
console.log("design worker: encerrado.");
process.exit(0);

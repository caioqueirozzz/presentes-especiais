import type { Banco } from "./banco.js";
import { PgLacunaStore } from "../knowledge/lacunas.js";
import { PgOrderIndexStore } from "../integrations/brindeme/orderIndex.js";
import { setLacunaStore } from "../tools/consultarConhecimento.js";
import { setOrderIndexStore } from "../tools/consultarPedido.js";

/** Liga nas tools os stores do banco. Toda entrada que atende cliente chama isto depois de abrirBanco(). */
export function ligarStores(banco: Banco): void {
  setLacunaStore(new PgLacunaStore(banco));
  setOrderIndexStore(new PgOrderIndexStore(banco));
}

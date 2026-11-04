import { setBuscarHistoricoCliente } from "../../src/integrations/crm/historicoCliente.js";

/*
 * O .env de desenvolvimento tem CRM_URL: sem isto, todo runTurn dos testes consultaria o CRM local
 * (histórico de pedidos do cliente). Por padrão o CRM "não responde" (a Lia segue sem histórico);
 * o teste que precisa do histórico injeta o seu com setBuscarHistoricoCliente.
 */
setBuscarHistoricoCliente(async () => {
  throw new Error("CRM desligado nos testes");
});

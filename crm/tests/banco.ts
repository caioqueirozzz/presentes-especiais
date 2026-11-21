import { randomUUID } from "node:crypto";
import { one, query } from "@/lib/db";

export async function limparBanco(): Promise<void> {
  await query("TRUNCATE design_jobs, notifications, messages, lead_events, orders, leads RESTART IDENTITY CASCADE");
  await query("UPDATE crm_settings SET last_assigned_user_id = NULL, last_designer_id = NULL WHERE id");
  // DELETE, não TRUNCATE CASCADE: o CASCADE esvaziaria crm_settings (referencia users)
  await query("DELETE FROM users");
}

let seq = 0;
export async function criarUsuario(p: { role: "ADMIN" | "COLABORADOR" | "DESIGNER"; nome?: string }): Promise<string> {
  seq++;
  const row = await one<{ id: string }>(
    // created_at estritamente crescente: o rodízio ordena por ele e dois usuários no mesmo milissegundo empatariam
    "INSERT INTO users (name, email, password_hash, role, receives_leads, created_at) VALUES ($1, $2, 'x', $3, $4, clock_timestamp() + make_interval(secs => $5::int / 1000.0)) RETURNING id",
    [p.nome ?? `Pessoa ${seq}`, `p${seq}-${randomUUID().slice(0, 6)}@teste.local`, p.role, p.role === "COLABORADOR", seq]
  );
  return row!.id;
}

export async function criarLead(p: { phone?: string; assignedTo?: string | null; agentMode?: "ia" | "humano" } = {}): Promise<string> {
  seq++;
  const row = await one<{ id: string }>(
    "INSERT INTO leads (phone, source, assigned_to, agent_mode, name) VALUES ($1, 'AGENTE', $2, $3, $4) RETURNING id",
    [p.phone ?? `55119000${String(seq).padStart(5, "0")}`, p.assignedTo ?? null, p.agentMode ?? "ia", `Cliente ${seq}`]
  );
  return row!.id;
}

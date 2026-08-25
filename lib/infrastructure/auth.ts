import { ALL_ROLES, type Actor, type Role } from "../domain";
import { createSupabaseUserClient } from "./supabase";

export async function requireServerActor(): Promise<Actor> {
  const client = await createSupabaseUserClient(), { data, error } = await client.auth.getUser(); if (error || !data.user) throw new Error("UNAUTHENTICATED");
  const userResult = await client.from("usuarios").select("estado").eq("id", data.user.id).maybeSingle(), user = userResult.data as unknown as { estado: string } | null; if (userResult.error || !user || user.estado !== "activo") throw new Error("ACCOUNT_INACTIVE");
  const { data: roles, error: roleError } = await client.from("usuario_roles").select("rol").eq("usuario_id", data.user.id); if (roleError) throw new Error("AUTHZ_LOOKUP_FAILED");
  const assigned = ((roles ?? []) as Array<{ rol: string }>).map((row) => row.rol).filter((role): role is Role => ALL_ROLES.includes(role as Role)); if (!assigned.length) throw new Error("ROLE_REQUIRED");
  return { id: data.user.id, roles: assigned };
}

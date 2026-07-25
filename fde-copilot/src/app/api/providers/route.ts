import { NextResponse } from "next/server";
import { authError } from "@/lib/auth";
import {
  availableDefaultSelection,
  discoverProviders,
  resolveProviderSelection,
} from "@/lib/providers/registry";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const denied = authError(req);
  if (denied) return denied;
  const providers = await discoverProviders();
  return NextResponse.json({
    providers,
    defaultSelection: availableDefaultSelection(providers, resolveProviderSelection()),
  });
}

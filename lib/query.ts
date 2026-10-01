import type { Station } from "../store/incident";

export async function fetchStations(): Promise<Station[]> {
  await new Promise((resolve) => setTimeout(resolve, 120));
  const raw = localStorage.getItem("pair-wise-yf-47/incident");
  if (!raw) return [];
  return (JSON.parse(raw).state?.stations ?? []) as Station[];
}

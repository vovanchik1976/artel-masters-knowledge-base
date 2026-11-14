/** Helpers for the phone approval fallback (D-109). */

/** Extract the short-lived login token from TDLib's tg://login QR link. */
export function extractLoginTokenFromLink(link: string): string {
  const match = (link || "").match(/[?&]token=([^&]+)/);
  if (!match?.[1]) return "";
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return "";
  }
}

export type WidgetLoginStatus =
  | "waiting_token"
  | "link_sent"
  | "send_failed"
  | "finished";

export function widgetLoginMessage(status: string | undefined): "waiting" | "sent" | "failed" {
  if (status === "link_sent") return "sent";
  if (status === "send_failed") return "failed";
  return "waiting";
}

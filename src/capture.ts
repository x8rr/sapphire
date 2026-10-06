import { ApiError } from "./realm";
import type { Sapphire } from "./sapphire";

/**
 * tabs.captureVisibleTab. A page can't screenshot another frame by itself, so
 * this asks the host first and otherwise falls back to getDisplayMedia (which
 * prompts the user) and crops to the tab's iframe.
 */
export async function captureVisibleTab(s: Sapphire, tabId: number | null, format: string, quality?: number): Promise<string> {
  if (s.host.captureTab) {
    const url = await s.host.captureTab(tabId, format, quality);
    if (url) return url;
  }
  if (!navigator.mediaDevices?.getDisplayMedia) throw new ApiError("Failed to capture tab: capture is not supported.");
  let stream: MediaStream | null = null;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: "browser" },
      preferCurrentTab: true,
    } as DisplayMediaStreamOptions);
    const video = document.createElement("video");
    video.srcObject = stream;
    video.muted = true;
    await video.play();
    await new Promise<void>((resolve) => {
      if (video.readyState >= 2) resolve();
      else video.addEventListener("loadeddata", () => resolve(), { once: true });
    });
    const canvas = document.createElement("canvas");
    const frameEl = tabId !== null ? (s.host.getTabWindow?.(tabId)?.frameElement as Element | null | undefined) : null;
    const scaleX = video.videoWidth / window.innerWidth;
    const scaleY = video.videoHeight / window.innerHeight;
    const rect = frameEl?.getBoundingClientRect() ?? new DOMRect(0, 0, window.innerWidth, window.innerHeight);
    canvas.width = Math.max(1, Math.round(rect.width * scaleX));
    canvas.height = Math.max(1, Math.round(rect.height * scaleY));
    canvas.getContext("2d")?.drawImage(video, rect.left * scaleX, rect.top * scaleY, rect.width * scaleX, rect.height * scaleY, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL(format, quality !== undefined ? quality / 100 : undefined);
  } catch (e) {
    throw new ApiError(`Failed to capture tab: ${(e as Error)?.message ?? e}`);
  } finally {
    stream?.getTracks().forEach((t) => t.stop());
  }
}

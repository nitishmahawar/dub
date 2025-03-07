import {
  LOCALHOST_GEO_DATA,
  LOCALHOST_IP,
  capitalize,
  getDomainWithoutWWW,
  hashStringSHA256,
  nanoid,
} from "@dub/utils";
import { ipAddress } from "@vercel/edge";
import { NextRequest, userAgent } from "next/server";
import { detectBot } from "./middleware/utils";
import { conn } from "./planetscale";
import { LinkProps } from "./types";
import { ratelimit } from "./upstash";

/**
 * Recording clicks with geo, ua, referer and timestamp data
 **/
export async function recordClick({
  req,
  id,
  url,
  root,
}: {
  req: NextRequest;
  id: string;
  url?: string;
  root?: boolean;
}) {
  const isBot = detectBot(req);
  if (isBot) {
    return null;
  }
  const geo = process.env.VERCEL === "1" ? req.geo : LOCALHOST_GEO_DATA;
  const ua = userAgent(req);
  const referer = req.headers.get("referer");
  const ip = ipAddress(req) || LOCALHOST_IP;
  // if in production / preview env, deduplicate clicks from the same IP & link ID – only record 1 click per hour
  if (process.env.VERCEL === "1") {
    const { success } = await ratelimit(2, "1 h").limit(
      `recordClick:${ip}:${id}`,
    );
    if (!success) {
      return null;
    }
  }
  // combine IP + UA to create a unique identifier for the user (for deduplication)
  const identity_hash = await hashStringSHA256(`${ip}-${ua.ua}`);

  return await Promise.allSettled([
    fetch(
      `${process.env.TINYBIRD_API_URL}/v0/events?name=dub_click_events&wait=true`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.TINYBIRD_API_KEY}`,
        },
        body: JSON.stringify({
          timestamp: new Date(Date.now()).toISOString(),
          identity_hash,
          click_id: nanoid(16),
          link_id: id,
          alias_link_id: "",
          url: url || "",
          country: geo?.country || "Unknown",
          city: geo?.city || "Unknown",
          region: geo?.region || "Unknown",
          latitude: geo?.latitude || "Unknown",
          longitude: geo?.longitude || "Unknown",
          device: ua.device.type ? capitalize(ua.device.type) : "Desktop",
          device_vendor: ua.device.vendor || "Unknown",
          device_model: ua.device.model || "Unknown",
          browser: ua.browser.name || "Unknown",
          browser_version: ua.browser.version || "Unknown",
          engine: ua.engine.name || "Unknown",
          engine_version: ua.engine.version || "Unknown",
          os: ua.os.name || "Unknown",
          os_version: ua.os.version || "Unknown",
          cpu_architecture: ua.cpu?.architecture || "Unknown",
          ua: ua.ua || "Unknown",
          bot: ua.isBot,
          referer: referer
            ? getDomainWithoutWWW(referer) || "(direct)"
            : "(direct)",
          referer_url: referer || "(direct)",
        }),
      },
    ).then((res) => res.json()),

    // increment the click count for the link or domain (based on their ID)
    // also increment the usage count for the project (if it's a link click)
    // and then we have a cron that will reset it at the start of new billing cycle
    root
      ? conn.execute(
          "UPDATE Domain SET clicks = clicks + 1, lastClicked = NOW() WHERE id = ?",
          [id],
        )
      : [
          conn.execute(
            "UPDATE Link SET clicks = clicks + 1, lastClicked = NOW() WHERE id = ?",
            [id],
          ),
          conn.execute(
            "UPDATE Project p JOIN Link l ON p.id = l.projectId SET p.usage = p.usage + 1 WHERE l.id = ?",
            [id],
          ),
        ],
  ]);
}

export async function recordLink({
  link,
  deleted,
}: {
  link: Partial<LinkProps>;
  deleted?: boolean;
}) {
  return await fetch(
    `${process.env.TINYBIRD_API_URL}/v0/events?name=dub_links_metadata&wait=true`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.TINYBIRD_API_KEY}`,
      },
      body: JSON.stringify({
        timestamp: new Date(Date.now()).toISOString(),
        link_id: link.id,
        domain: link.domain,
        key: link.key,
        url: link.url,
        project_id: link.projectId || "",
        deleted: deleted ? 1 : 0,
      }),
    },
  ).then((res) => res.json());
}

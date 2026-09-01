import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

export const getAdConfig = query({
  args: {},
  returns: v.union(
    v.object({
      _id: v.id("ad_config"),
      vastUrl: v.string(),
      enabled: v.boolean(),
      skipAfterSeconds: v.number(),
      showOnVideos: v.boolean(),
      showOnShorts: v.boolean(),
    }),
    v.null()
  ),
  handler: async (ctx) => {
    const config = await ctx.db.query("ad_config").order("desc").first();
    if (!config) return null;
    return {
      _id: config._id,
      vastUrl: config.vastUrl,
      enabled: config.enabled,
      skipAfterSeconds: config.skipAfterSeconds,
      showOnVideos: config.showOnVideos,
      showOnShorts: config.showOnShorts,
    };
  },
});

export const getPrerollAdSelection = query({
  args: {},
  returns: v.union(
    v.object({
      type: v.literal("luku"),
      _id: v.id("ad_requests"),
      creativeUrl: v.string(),
      ctaUrl: v.union(v.string(), v.null()),
      campaignTitle: v.string(),
      companyName: v.string(),
      skipAfterSeconds: v.number(),
    }),
    v.object({
      type: v.literal("vast"),
      vastUrl: v.string(),
      skipAfterSeconds: v.number(),
    })
  ),
  handler: async (ctx) => {
    const fallback = await ctx.db.query("ad_config").order("desc").first();
    const fallbackVastUrl = fallback?.vastUrl || "https://vast.hilltopads.com/?zone_id=YOUR_ZONE_ID";
    const fallbackSkip = fallback?.skipAfterSeconds || 5;

    const recentPaidAds = await ctx.db
      .query("ad_requests")
      .withIndex("by_ad_type_and_payment_status", (q: any) =>
        q.eq("ad_type", "preroll").eq("payment_status", "paid")
      )
      .order("desc")
      .take(20);

    const eligible = recentPaidAds.filter((ad: {
      status: string;
      creative_url?: string | null;
      _id: any;
      cta_url?: string | null;
      campaign_title?: string | null;
      company_name?: string | null;
      skip_after_seconds?: number | null;
    }) => {
      return (ad.status === "approved" || ad.status === "live") && !!ad.creative_url;
    });

    if (eligible.length > 0) {
      const selected = eligible[Math.floor(Math.random() * eligible.length)];
      return {
        type: "luku" as const,
        _id: selected._id,
        creativeUrl: selected.creative_url!,
        ctaUrl: selected.cta_url || null,
        campaignTitle: selected.campaign_title || selected.company_name || "LukuLuku Ads",
        companyName: selected.company_name || "LukuLuku Ads",
        skipAfterSeconds: selected.skip_after_seconds || fallbackSkip,
      };
    }

    return {
      type: "vast" as const,
      vastUrl: fallbackVastUrl,
      skipAfterSeconds: fallbackSkip,
    };
  },
});

export const setAdConfig = mutation({
  args: {
    vastUrl: v.string(),
    enabled: v.boolean(),
    skipAfterSeconds: v.number(),
    showOnVideos: v.boolean(),
    showOnShorts: v.boolean(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    // Remove old configs
    const existing = await ctx.db.query("ad_config").collect();
    for (const doc of existing) {
      await ctx.db.delete(doc._id);
    }
    await ctx.db.insert("ad_config", {
      vastUrl: args.vastUrl,
      enabled: args.enabled,
      skipAfterSeconds: args.skipAfterSeconds,
      showOnVideos: args.showOnVideos,
      showOnShorts: args.showOnShorts,
    });
    return null;
  },
});

export const seedAdConfig = mutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const existing = await ctx.db.query("ad_config").take(1);
    if (existing.length > 0) return null;
    
    await ctx.db.insert("ad_config", {
      vastUrl: "https://vast.hilltopads.com/?zone_id=YOUR_ZONE_ID",
      enabled: true,
      skipAfterSeconds: 5,
      showOnVideos: true,
      showOnShorts: false,
    });
    return null;
  },
});
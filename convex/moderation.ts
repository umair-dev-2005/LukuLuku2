import { v } from "convex/values";
import {
  action,
  mutation,
  query,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import { internal } from "./_generated/api";

// --- Public mutation: generate upload URL for file storage ---
export const generateUploadUrl = mutation({
  args: {},
  returns: v.string(),
  handler: async (ctx) => {
    return await ctx.storage.generateUploadUrl();
  },
});

// --- Public mutation: get image URL from storage ID ---
export const getImageUrl = query({
  args: { storageId: v.id("_storage") },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => {
    return await ctx.storage.getUrl(args.storageId);
  },
});

// --- Public mutation: delete image from storage ---
export const deleteImage = mutation({
  args: { storageId: v.id("_storage") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.storage.delete(args.storageId);
    return null;
  },
});

// --- Internal helpers for use by the action ---
export const _getStorageUrl = internalQuery({
  args: { storageId: v.id("_storage") },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => {
    return await ctx.storage.getUrl(args.storageId);
  },
});

export const _deleteFromStorage = internalMutation({
  args: { storageId: v.id("_storage") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.storage.delete(args.storageId);
    return null;
  },
});

export const _logViolation = internalMutation({
  args: {
    supabaseUserId: v.string(),
    imageStorageId: v.optional(v.string()),
    reason: v.string(),
    nudityScore: v.number(),
    violenceScore: v.number(),
    adultScore: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.insert("moderation_logs", {
      supabaseUserId: args.supabaseUserId,
      imageStorageId: args.imageStorageId,
      reason: args.reason,
      nudityScore: args.nudityScore,
      violenceScore: args.violenceScore,
      adultScore: args.adultScore,
      action: "auto_delete",
    });
    return null;
  },
});

// --- Main moderation action ---
export const moderateImage = action({
  args: {
    storageId: v.id("_storage"),
    supabaseUserId: v.string(),
  },
  returns: v.object({
    approved: v.boolean(),
    reason: v.string(),
    imageUrl: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    const imageUrl: string | null = await ctx.runQuery(
      internal.moderation._getStorageUrl,
      { storageId: args.storageId }
    );

    if (!imageUrl) {
      return { approved: false, reason: "Image not found in storage." };
    }

    try {
      const response = await globalThis.fetch("https://api.a0.dev/ai/llm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [
            {
              role: "system",
              content:
                "You are a strict content moderation AI for a family-friendly social media platform. " +
                "Analyze the provided image and rate it on the following categories. " +
                "Be strict: any hint of nudity, sexual content, graphic violence, gore, or drug use should score high.",
            },
            {
              role: "user",
              content: [
                { type: "image_url", image_url: { url: imageUrl } },
                {
                  type: "text",
                  text: "Rate this image for content moderation. Score each category from 0.0 (completely safe) to 1.0 (explicit/dangerous). Categories: nudity, violence, adult_content.",
                },
              ],
            },
          ],
          schema: {
            type: "object",
            properties: {
              safe: {
                type: "boolean",
                description:
                  "true if the image is appropriate for a family-friendly social platform",
              },
              nudity_score: {
                type: "number",
                description: "Nudity/partial nudity score 0.0-1.0",
              },
              violence_score: {
                type: "number",
                description: "Violence/gore/weapons score 0.0-1.0",
              },
              adult_score: {
                type: "number",
                description: "Adult/sexual content score 0.0-1.0",
              },
              reason: {
                type: "string",
                description: "Brief explanation of the assessment",
              },
            },
            required: [
              "safe",
              "nudity_score",
              "violence_score",
              "adult_score",
              "reason",
            ],
          },
        }),
      });

      const data = await response.json();
      const result = data.schema_data || {};

      const nudity = typeof result.nudity_score === "number" ? result.nudity_score : 0;
      const violence = typeof result.violence_score === "number" ? result.violence_score : 0;
      const adult = typeof result.adult_score === "number" ? result.adult_score : 0;

      const NUDITY_THRESHOLD = 0.4;
      const VIOLENCE_THRESHOLD = 0.6;
      const ADULT_THRESHOLD = 0.4;

      const isUnsafe =
        nudity > NUDITY_THRESHOLD ||
        violence > VIOLENCE_THRESHOLD ||
        adult > ADULT_THRESHOLD ||
        result.safe === false;

      if (isUnsafe) {
        const reasonText = result.reason || "Content flagged by automated moderation.";

        await ctx.runMutation(internal.moderation._logViolation, {
          supabaseUserId: args.supabaseUserId,
          imageStorageId: args.storageId,
          reason: reasonText,
          nudityScore: nudity,
          violenceScore: violence,
          adultScore: adult,
        });

        await ctx.runMutation(internal.moderation._deleteFromStorage, {
          storageId: args.storageId,
        });

        return { approved: false, reason: reasonText };
      }

      return { approved: true, reason: "Content approved.", imageUrl };
    } catch (error: any) {
      console.error("Moderation API error:", error?.message || error);
      return { approved: true, reason: "Moderation check skipped.", imageUrl };
    }
  },
});

export const getModerationLogs = query({
  args: {},
  returns: v.array(
    v.object({
      _id: v.id("moderation_logs"),
      _creationTime: v.number(),
      supabaseUserId: v.string(),
      reason: v.string(),
      nudityScore: v.number(),
      violenceScore: v.number(),
      adultScore: v.number(),
      action: v.string(),
    })
  ),
  handler: async (ctx) => {
    const logs = await ctx.db
      .query("moderation_logs")
      .order("desc")
      .take(100);
    return logs.map((log: any) => ({
      _id: log._id,
      _creationTime: log._creationTime,
      supabaseUserId: log.supabaseUserId,
      reason: log.reason,
      nudityScore: log.nudityScore,
      violenceScore: log.violenceScore,
      adultScore: log.adultScore,
      action: log.action,
    }));
  },
});

export const getUserViolationCount = query({
  args: { supabaseUserId: v.string() },
  returns: v.number(),
  handler: async (ctx, args) => {
    const logs = await ctx.db
      .query("moderation_logs")
      .withIndex("by_supabaseUserId", (q: any) =>
        q.eq("supabaseUserId", args.supabaseUserId)
      )
      .collect();
    return logs.length;
  },
});

export const purgeAccountData = mutation({
  args: {
    supabaseUserId: v.string(),
    confirmationText: v.string(),
  },
  returns: v.object({
    deletedCount: v.number(),
  }),
  handler: async (ctx, args) => {
    if (args.confirmationText.trim().toUpperCase() !== "DELETE") {
      throw new Error("Type DELETE to confirm account deletion.");
    }

    const deletedIds = new Set<string>();
    let deletedCount = 0;

    const deleteDocs = async (rows: Array<{ _id: string }>) => {
      for (const row of rows) {
        if (deletedIds.has(row._id)) continue;
        deletedIds.add(row._id);
        await ctx.db.delete(row._id as any);
        deletedCount += 1;
      }
    };

    await deleteDocs(
      await ctx.db
        .query("creator_wallets")
        .withIndex("by_supabaseUserId", (q: any) =>
          q.eq("supabaseUserId", args.supabaseUserId)
        )
        .collect()
    );

    await deleteDocs(
      await ctx.db
        .query("withdrawal_requests")
        .withIndex("by_supabaseUserId", (q: any) =>
          q.eq("supabaseUserId", args.supabaseUserId)
        )
        .collect()
    );

    await deleteDocs(
      await ctx.db
        .query("content_income_claims")
        .withIndex("by_claimantSupabaseUserId", (q: any) =>
          q.eq("claimantSupabaseUserId", args.supabaseUserId)
        )
        .collect()
    );

    await deleteDocs(
      await ctx.db
        .query("moderation_logs")
        .withIndex("by_supabaseUserId", (q: any) =>
          q.eq("supabaseUserId", args.supabaseUserId)
        )
        .collect()
    );

    await deleteDocs(
      await ctx.db
        .query("terms_acceptances")
        .withIndex("by_supabaseUserId", (q: any) =>
          q.eq("supabaseUserId", args.supabaseUserId)
        )
        .collect()
    );

    await deleteDocs(
      await ctx.db
        .query("game_scores")
        .withIndex("by_user", (q: any) => q.eq("supabaseUserId", args.supabaseUserId))
        .collect()
    );

    const blocksAsBlocker = await ctx.db
      .query("user_blocks")
      .withIndex("by_blockerSupabaseUserId", (q: any) =>
        q.eq("blockerSupabaseUserId", args.supabaseUserId)
      )
      .collect();

    const blocksAsBlocked = await ctx.db
      .query("user_blocks")
      .withIndex("by_blockedSupabaseUserId", (q: any) =>
        q.eq("blockedSupabaseUserId", args.supabaseUserId)
      )
      .collect();

    await deleteDocs([...blocksAsBlocker, ...blocksAsBlocked]);

    const reportsAsReporter = await ctx.db
      .query("content_reports")
      .withIndex("by_reporterSupabaseUserId", (q: any) =>
        q.eq("reporterSupabaseUserId", args.supabaseUserId)
      )
      .collect();

    const reportsAsTarget = await ctx.db
      .query("content_reports")
      .withIndex("by_targetSupabaseUserId", (q: any) =>
        q.eq("targetSupabaseUserId", args.supabaseUserId)
      )
      .collect();

    await deleteDocs([...reportsAsReporter, ...reportsAsTarget]);

    return { deletedCount };
  },
});
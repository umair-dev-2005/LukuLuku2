import { defineSchema, defineTable } from "convex/server";
import { authTables } from "@convex-dev/auth/server";
import { v } from "convex/values";

const schema = defineSchema({
  ...authTables,
  creator_wallets: defineTable({
    supabaseUserId: v.string(),
    walletType: v.optional(v.string()),
    walletNumber: v.string(),
    walletAddress: v.optional(v.string()),
    accountHolder: v.string(),
    bankName: v.string(),
    isActive: v.boolean(),
  }).index("by_supabaseUserId", ["supabaseUserId"]),
  uni5pay_config: defineTable({
    appId: v.string(),
    merchantId: v.string(),
    mallName: v.string(),
    mallUrl: v.string(),
    signRand: v.string(),
    publicKey: v.string(),
    liveKey: v.string(),
    isActive: v.boolean(),
  }),
  withdrawal_requests: defineTable({
    supabaseUserId: v.string(),
    amount: v.number(),
    grossAmount: v.number(),
    netAmount: v.number(),
    minimumThreshold: v.number(),
    invoiceNumber: v.string(),
    walletType: v.optional(v.string()),
    walletNumber: v.string(),
    walletAddress: v.optional(v.string()),
    accountHolder: v.string(),
    bankName: v.string(),
    status: v.string(),
    recipientEmail: v.optional(v.string()),
    note: v.optional(v.string()),
  }).index("by_supabaseUserId", ["supabaseUserId"]),
  content_income_claims: defineTable({
    sourceVideoId: v.string(),
    claimantSupabaseUserId: v.string(),
    claimStatus: v.string(),
    claimSharePct: v.number(),
    platformSharePct: v.number(),
    note: v.optional(v.string()),
    isActive: v.boolean(),
  })
    .index("by_sourceVideoId", ["sourceVideoId"])
    .index("by_claimantSupabaseUserId", ["claimantSupabaseUserId"]),
  games: defineTable({
    name: v.string(),
    description: v.string(),
    thumbnailUrl: v.string(),
    gameType: v.string(), // "memory" | "tapspeed" | "colormatch" | "quiz"
    isActive: v.boolean(),
    playCount: v.number(),
    sortOrder: v.number(),
  }).index("by_active", ["isActive", "sortOrder"]),
  game_scores: defineTable({
    gameId: v.id("games"),
    supabaseUserId: v.string(),
    score: v.number(),
    displayName: v.string(),
  }).index("by_game", ["gameId"])
    .index("by_user", ["supabaseUserId"]),
  ad_config: defineTable({
    vastUrl: v.string(),
    enabled: v.boolean(),
    skipAfterSeconds: v.number(),
    showOnVideos: v.boolean(),
    showOnShorts: v.boolean(),
  }),
  ad_requests: defineTable({
    ad_type: v.string(),
    status: v.string(),
    payment_status: v.string(),
    creative_url: v.optional(v.string()),
    cta_url: v.optional(v.string()),
    campaign_title: v.optional(v.string()),
    company_name: v.optional(v.string()),
    campaign_description: v.optional(v.string()),
    website: v.optional(v.string()),
    skip_after_seconds: v.optional(v.number()),
  }).index("by_ad_type_and_payment_status", ["ad_type", "payment_status"]),
  moderation_logs: defineTable({
    supabaseUserId: v.string(),
    imageStorageId: v.optional(v.string()),
    reason: v.string(),
    nudityScore: v.number(),
    violenceScore: v.number(),
    adultScore: v.number(),
    action: v.string(),
  }).index("by_supabaseUserId", ["supabaseUserId"]),
  terms_acceptances: defineTable({
    supabaseUserId: v.string(),
    version: v.string(),
  }).index("by_supabaseUserId", ["supabaseUserId"]),
  user_blocks: defineTable({
    blockerSupabaseUserId: v.string(),
    blockedSupabaseUserId: v.string(),
    reason: v.optional(v.string()),
  })
    .index("by_blockerSupabaseUserId", ["blockerSupabaseUserId"])
    .index("by_blockedSupabaseUserId", ["blockedSupabaseUserId"]),
  content_reports: defineTable({
    reporterSupabaseUserId: v.string(),
    targetSupabaseUserId: v.string(),
    targetType: v.union(
      v.literal("video"),
      v.literal("short"),
      v.literal("post"),
      v.literal("comment"),
      v.literal("profile")
    ),
    contentId: v.string(),
    reason: v.string(),
    details: v.optional(v.string()),
    status: v.string(),
  })
    .index("by_reporterSupabaseUserId", ["reporterSupabaseUserId"])
    .index("by_targetSupabaseUserId", ["targetSupabaseUserId"])
    .index("by_targetType_and_contentId", ["targetType", "contentId"]),
});

export default schema;
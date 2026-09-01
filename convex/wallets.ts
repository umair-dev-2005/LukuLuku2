import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

const MIN_WITHDRAWAL_AMOUNT = 100;

function shortId() {
  const t = Date.now().toString().slice(-8); // 8 cijfers uit timestamp
  const r = Math.floor(Math.random() * 100).toString().padStart(2, "0"); // 2 random cijfers
  return (t + r).slice(0, 10);
}

function buildInvoiceNumber() {
  return shortId();
}

export const getUni5PayConfig = query({
  args: {},
  returns: v.union(
    v.object({
      _id: v.id("uni5pay_config"),
      appId: v.string(),
      merchantId: v.string(),
      mallName: v.string(),
      mallUrl: v.string(),
      isActive: v.boolean(),
    }),
    v.null()
  ),
  handler: async (ctx) => {
    const config = await ctx.db.query("uni5pay_config").order("desc").first();
    if (!config) return null;
    return {
      _id: config._id,
      appId: config.appId,
      merchantId: config.merchantId,
      mallName: config.mallName,
      mallUrl: config.mallUrl,
      isActive: config.isActive,
    };
  },
});

export const setUni5PayConfig = mutation({
  args: {
    appId: v.string(),
    merchantId: v.string(),
    mallName: v.string(),
    mallUrl: v.string(),
    signRand: v.string(),
    publicKey: v.string(),
    liveKey: v.string(),
    isActive: v.boolean(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await ctx.db.query("uni5pay_config").collect();
    for (const doc of existing) {
      await ctx.db.delete(doc._id);
    }

    await ctx.db.insert("uni5pay_config", {
      appId: args.appId,
      merchantId: args.merchantId,
      mallName: args.mallName,
      mallUrl: args.mallUrl,
      signRand: args.signRand,
      publicKey: args.publicKey,
      liveKey: args.liveKey,
      isActive: args.isActive,
    });
    return null;
  },
});

export const getWallet = query({
  args: { supabaseUserId: v.string() },
  returns: v.union(
    v.object({
      _id: v.id("creator_wallets"),
      _creationTime: v.number(),
      supabaseUserId: v.string(),
      walletType: v.string(),
      walletNumber: v.string(),
      walletAddress: v.union(v.string(), v.null()),
      accountHolder: v.string(),
      bankName: v.string(),
      isActive: v.boolean(),
    }),
    v.null()
  ),
  handler: async (ctx, args) => {
    const wallet = await ctx.db
      .query("creator_wallets")
      .withIndex("by_supabaseUserId", (q: any) => q.eq("supabaseUserId", args.supabaseUserId))
      .order("desc")
      .first();
    if (!wallet) return null;
    return {
      _id: wallet._id,
      _creationTime: wallet._creationTime,
      supabaseUserId: wallet.supabaseUserId,
      walletType: wallet.walletType || 'uni5pay',
      walletNumber: wallet.walletNumber,
      walletAddress: wallet.walletAddress || null,
      accountHolder: wallet.accountHolder,
      bankName: wallet.bankName,
      isActive: wallet.isActive,
    };
  },
});

export const saveWallet = mutation({
  args: {
    supabaseUserId: v.string(),
    walletType: v.string(),
    walletNumber: v.string(),
    walletAddress: v.optional(v.string()),
    accountHolder: v.string(),
  },
  returns: v.id("creator_wallets"),
  handler: async (ctx, args) => {
    // Check if wallet already exists
    const existing = await ctx.db
      .query("creator_wallets")
      .withIndex("by_supabaseUserId", (q: any) => q.eq("supabaseUserId", args.supabaseUserId))
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        walletType: args.walletType,
        walletNumber: args.walletNumber,
        walletAddress: args.walletAddress,
        accountHolder: args.accountHolder,
      });
      return existing._id;
    }

    return await ctx.db.insert("creator_wallets", {
      supabaseUserId: args.supabaseUserId,
      walletType: args.walletType,
      walletNumber: args.walletNumber,
      walletAddress: args.walletAddress,
      accountHolder: args.accountHolder,
      bankName: "Southern Commercial Bank - Uni5Pay",
      isActive: true,
    });
  },
});

export const getWithdrawals = query({
  args: { supabaseUserId: v.string() },
  returns: v.array(
    v.object({
      _id: v.id("withdrawal_requests"),
      _creationTime: v.number(),
      amount: v.number(),
      grossAmount: v.number(),
      netAmount: v.number(),
      minimumThreshold: v.number(),
      invoiceNumber: v.string(),
      status: v.string(),
      recipientEmail: v.optional(v.string()),
      note: v.optional(v.string()),
    })
  ),
  handler: async (ctx, args) => {
    const withdrawals = await ctx.db
      .query("withdrawal_requests")
      .withIndex("by_supabaseUserId", (q: any) => q.eq("supabaseUserId", args.supabaseUserId))
      .order("desc")
      .take(20);
    return withdrawals.map((w: any) => ({
      _id: w._id,
      _creationTime: w._creationTime,
      amount: w.amount,
      grossAmount: w.grossAmount,
      netAmount: w.netAmount,
      minimumThreshold: w.minimumThreshold,
      invoiceNumber: w.invoiceNumber,
      status: w.status,
      recipientEmail: w.recipientEmail,
      note: w.note,
    }));
  },
});

export const requestWithdrawal = mutation({
  args: {
    supabaseUserId: v.string(),
    amount: v.number(),
    recipientEmail: v.optional(v.string()),
  },
  returns: v.object({
    withdrawalId: v.id("withdrawal_requests"),
    invoiceNumber: v.string(),
  }),
  handler: async (ctx, args) => {
    // Get wallet
    const wallet = await ctx.db
      .query("creator_wallets")
      .withIndex("by_supabaseUserId", (q: any) => q.eq("supabaseUserId", args.supabaseUserId))
      .first();

    if (!wallet) {
      throw new Error("No wallet found. Please set up your Uni5Pay wallet first.");
    }

    if (args.amount < MIN_WITHDRAWAL_AMOUNT) {
      throw new Error(`Minimum withdrawal amount is SRD ${MIN_WITHDRAWAL_AMOUNT}.`);
    }

    const invoiceNumber = buildInvoiceNumber();

    const withdrawalId = await ctx.db.insert("withdrawal_requests", {
      supabaseUserId: args.supabaseUserId,
      amount: args.amount,
      grossAmount: args.amount,
      netAmount: args.amount,
      minimumThreshold: MIN_WITHDRAWAL_AMOUNT,
      invoiceNumber,
      walletType: wallet.walletType,
      walletNumber: wallet.walletNumber,
      walletAddress: wallet.walletAddress,
      accountHolder: wallet.accountHolder,
      bankName: wallet.bankName,
      status: "pending",
      recipientEmail: args.recipientEmail,
      note: "Opnamefactuur aangemaakt",
    });

    return {
      withdrawalId,
      invoiceNumber,
    };
  },
});
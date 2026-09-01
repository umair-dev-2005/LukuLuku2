import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

export const listGames = query({
  args: {},
  returns: v.array(
    v.object({
      _id: v.id("games"),
      _creationTime: v.number(),
      name: v.string(),
      description: v.string(),
      thumbnailUrl: v.string(),
      gameType: v.string(),
      isActive: v.boolean(),
      playCount: v.number(),
      sortOrder: v.number(),
    })
  ),
  handler: async (ctx) => {
    const games = await ctx.db
      .query("games")
      .withIndex("by_active", (q) => q.eq("isActive", true))
      .collect();
    return games.map((g) => ({
      _id: g._id,
      _creationTime: g._creationTime,
      name: g.name,
      description: g.description,
      thumbnailUrl: g.thumbnailUrl,
      gameType: g.gameType,
      isActive: g.isActive,
      playCount: g.playCount,
      sortOrder: g.sortOrder,
    }));
  },
});

export const incrementPlayCount = mutation({
  args: { gameId: v.id("games") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const game = await ctx.db.get(args.gameId);
    if (game) {
      await ctx.db.patch(args.gameId, { playCount: game.playCount + 1 });
    }
    return null;
  },
});

export const saveScore = mutation({
  args: {
    gameId: v.id("games"),
    supabaseUserId: v.string(),
    score: v.number(),
    displayName: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.insert("game_scores", {
      gameId: args.gameId,
      supabaseUserId: args.supabaseUserId,
      score: args.score,
      displayName: args.displayName,
    });
    return null;
  },
});

export const getTopScores = query({
  args: { gameId: v.id("games") },
  returns: v.array(
    v.object({
      _id: v.id("game_scores"),
      _creationTime: v.number(),
      score: v.number(),
      displayName: v.string(),
    })
  ),
  handler: async (ctx, args) => {
    const scores = await ctx.db
      .query("game_scores")
      .withIndex("by_game", (q) => q.eq("gameId", args.gameId))
      .order("desc")
      .take(10);
    return scores.map((s) => ({
      _id: s._id,
      _creationTime: s._creationTime,
      score: s.score,
      displayName: s.displayName,
    }));
  },
});

export const seedGames = mutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    // Check if games already exist
    const existing = await ctx.db.query("games").take(1);
    if (existing.length > 0) return null;

    const games = [
      {
        name: "Memory Match",
        description: "Vind alle overeenkomende paren!",
        thumbnailUrl: "https://api.a0.dev/assets/image?text=memory%20match%20card%20game%20colorful%20brain%20puzzle&aspect=16:9",
        gameType: "memory",
        isActive: true,
        playCount: 0,
        sortOrder: 1,
      },
      {
        name: "Tap Speed",
        description: "Hoe snel kun je tikken?",
        thumbnailUrl: "https://api.a0.dev/assets/image?text=fast%20tap%20speed%20challenge%20game%20neon%20finger&aspect=16:9",
        gameType: "tapspeed",
        isActive: true,
        playCount: 0,
        sortOrder: 2,
      },
      {
        name: "Color Match",
        description: "Kies de juiste kleur!",
        thumbnailUrl: "https://api.a0.dev/assets/image?text=color%20match%20puzzle%20game%20vibrant%20rainbow&aspect=16:9",
        gameType: "colormatch",
        isActive: true,
        playCount: 0,
        sortOrder: 3,
      },
      {
        name: "Quick Quiz",
        description: "Test je kennis!",
        thumbnailUrl: "https://api.a0.dev/assets/image?text=quiz%20trivia%20game%20question%20mark%20brain&aspect=16:9",
        gameType: "quiz",
        isActive: true,
        playCount: 0,
        sortOrder: 4,
      },
    ];

    for (const game of games) {
      await ctx.db.insert("games", game);
    }
    return null;
  },
});

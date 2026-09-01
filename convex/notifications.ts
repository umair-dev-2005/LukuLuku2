/**
  * a0 Push Notifications — internal server-side action.
  *
  * This is an INTERNAL action — it cannot be called from the client.
  * Call it from other Convex functions using:
  *
  *    import { internal } from "./_generated/api";
  *    await ctx.runAction(internal.notifications.sendNotification, { ... });
  *
  * HOW TO USE:
  *
  * 1. Get the device push token on the client using expo-notifications:
  *
  *    import * as Notifications from "expo-notifications";
  *
  *    const { status } = await Notifications.requestPermissionsAsync();
  *    if (status !== "granted") return;
  *
  *    // IMPORTANT: Use getDevicePushTokenAsync(), NOT getExpoPushTokenAsync()
  *    const { data: devicePushToken } = await Notifications.getDevicePushTokenAsync();
  *
  *    // Save devicePushToken to your Convex database
  *
  * 2. Send a notification from another Convex function:
  *
  *    import { internal } from "./_generated/api";
  *
  *    // From a mutation (e.g. when a message is sent):
  *    await ctx.scheduler.runAfter(0, internal.notifications.sendNotification, {
  *      to: devicePushToken,        // string or string[]
  *      title: "New Message",
  *      body: "You have a new message",
  *      data: { screen: "chat" },   // optional
  *      badge: 1,                   // optional (iOS only)
  *    });
  *
  *    // From an action:
  *    await ctx.runAction(internal.notifications.sendNotification, { ... });
  *
  * IMPORTANT:
  * - This function is internal — users cannot call it from the client.
  * - Platform (iOS/Android) is auto-detected from the token format.
  * - Sound is always "default".
  * - iOS environment (production vs sandbox) is handled automatically.
  * - Push notifications do NOT work in Expo Go or the a0 preview app.
  *   Test with a custom APK (Android) or TestFlight build (iOS).
  * - If users get "no valid aps-environment entitlement", they need a new build.
  *
  * Setup guide: https://docs.a0.dev/development/push-notifications
  */
  "use node";
  
  import { internalAction } from "./_generated/server";
  import { v } from "convex/values";
  
  const A0_NOTIFICATIONS_API_URL = "https://api2.a0.dev/api/notifications/send";
  
  export const sendNotification = internalAction({
    args: {
      to: v.union(v.string(), v.array(v.string())),
      title: v.string(),
      body: v.string(),
      data: v.optional(v.record(v.string(), v.union(v.string(), v.number(), v.boolean(), v.null()))),
      badge: v.optional(v.number()),
    },
    returns: v.any(),
    handler: async (_ctx, args) => {
      const serverKey = process.env.A0_SERVER_KEY;
      if (!serverKey) {
        throw new Error("Missing A0_SERVER_KEY in Convex environment variables.");
      }
  
      const response = await fetch(A0_NOTIFICATIONS_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${serverKey}`,
        },
        body: JSON.stringify(args),
      });
  
      const responseBody = await response.text();
      if (!response.ok) {
        throw new Error(`a0 notifications API error (${response.status}): ${responseBody}`);
      }
  
      try {
        return JSON.parse(responseBody);
      } catch {
        return { data: responseBody };
      }
    },
  });
  
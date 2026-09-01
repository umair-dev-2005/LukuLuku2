import { convexAuth } from "@convex-dev/auth/server";
import { A0Social } from "./a0Social";

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [A0Social],
});
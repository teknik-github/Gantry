// Sign-in, first-run setup and two-factor screens.
export const auth = {
  brand: {
    title: "Every Docker host, stack and cluster in one yard.",
    body: "Run, update and expose containers, deploy stacks from templates or Git, and get told when something goes wrong.",
  },
  titles: {
    login: "Login",
    setup: "Setup",
    twoFactor: "Two-factor authentication",
  },
  login: {
    title: "Login to Gantry",
    description: "Enter your username and password to continue",
    adminsOnly: "Sign in with SSO. The password form is for administrators only.",
    signingIn: "Signing in…",
    submit: "Login",
    forgot: "Forgot your password? Ask a Gantry administrator to reset it.",
    or: "Or",
    sso: "Sign in with SSO",
  },
  /** ?sso=<reason> after a failed single sign-on attempt. */
  sso: {
    not_linked:
      "This SSO account isn't linked to a Gantry user. Ask an administrator, or sign in with your password and link it on your Account page.",
    failed: "Single sign-on failed. Try again or ask an administrator to check the server logs.",
    denied: "Single sign-on was cancelled.",
    expired: "The single sign-on attempt expired. Try again.",
    unavailable: "Single sign-on is unavailable right now.",
  },
  setup: {
    title: "Welcome to Gantry",
    description: "Create the administrator account to finish setting up",
    token: "Setup token",
    tokenHelp: "Printed in the server log ({logs}) and stored in {file}.",
    confirm: "Confirm password",
    creating: "Creating…",
    submit: "Create administrator",
    passwordHint: "Use at least 8 characters for the password.",
  },
  twoFactor: {
    title: "Two-factor authentication",
    description: "Enter the 6-digit code from your authenticator app",
    code: "Code",
    lostDevice: "Lost your device? Enter one of your recovery codes instead.",
    verifying: "Verifying…",
    verify: "Verify",
    anotherAccount: "Use another account",
  },
  errors: {
    enterCredentials: "Enter your username and password",
    tooManyAttempts: "Too many attempts. Try again in {seconds}s.",
    passwordBusy: "Too many sign-in attempts right now. Try again in a moment.",
    invalidCredentials: "Invalid username or password",
    ssoOnly: "Sign in with SSO. Password sign-in is reserved for administrators.",
    pendingExpired: "This sign-in has expired. Start again with your password.",
    enterCode: "Enter a code",
    invalidCode: "Invalid code",
    passwordsMismatch: "Passwords do not match",
    alreadySetUp: "Gantry is already set up. Please sign in.",
    invalidSetupToken: "Invalid setup token",
  },
} as const

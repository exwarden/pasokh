import { redirect } from "next/navigation";
import { AuthError } from "next-auth";
import AuthCard, { Field, FormError, SubmitButton } from "@/components/auth-card";
import { PASSWORD_PROVIDER_ID, signIn } from "@/lib/auth";
import { getI18n } from "@/lib/i18n/server";
import { AccountError, accountErrorFromQuery, createFirstOwner, needsFirstRunSetup } from "@/lib/users/accounts";
import { isSetupEnabled } from "@/lib/users/setup-token";
import { clearLoginFailures, isLoginThrottled, recordLoginFailure } from "@/lib/users/login-throttle";

// One shared counter for every visitor: a setup token is long and random, so a
// handful of wrong guesses per window is plenty for the operator and useless
// for anyone guessing.
const SETUP_THROTTLE_KEY = "setup-token";

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  const { t } = await getI18n();
  return { title: `${t("Set up Pasokh")} - ${t("Pasokh")}` };
}

/**
 * First run: the only way into a fresh instance. Creates the owner account and
 * workspace, then closes for good: once any user exists this page redirects
 * to /login, and createFirstOwner re-checks under a lock. It is closed until
 * SETUP_TOKEN is set in .env, and the form asks for it.
 */
export default async function SetupPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  if (!(await needsFirstRunSetup())) redirect("/login");
  const { t } = await getI18n();
  const { error } = await searchParams;
  const errorKey = accountErrorFromQuery(error);

  async function completeSetup(formData: FormData) {
    "use server";
    const field = (name: string) => String(formData.get(name) ?? "");
    let throttled: boolean;
    try {
      throttled = await isLoginThrottled(SETUP_THROTTLE_KEY, null);
    } catch {
      redirect(`/setup?error=${encodeURIComponent("Setup is unavailable right now. Try again in a minute.")}`);
    }
    if (throttled) {
      redirect(`/setup?error=${encodeURIComponent("Too many wrong setup tokens. Try again in 15 minutes.")}`);
    }
    try {
      await createFirstOwner({
        setupToken: field("setupToken"),
        name: field("name"),
        email: field("email"),
        password: field("password"),
        confirm: field("confirm"),
        workspaceName: field("workspace"),
      });
    } catch (e) {
      if (e instanceof AccountError) {
        if (e.message === "The setup token is wrong.") await recordLoginFailure(SETUP_THROTTLE_KEY, null);
        redirect(`/setup?error=${encodeURIComponent(e.message)}`);
      }
      throw e;
    }
    await clearLoginFailures(SETUP_THROTTLE_KEY);
    try {
      await signIn(PASSWORD_PROVIDER_ID, {
        email: field("email"),
        password: field("password"),
        redirectTo: "/dashboard",
      });
    } catch (e) {
      // The account exists now; if the automatic sign-in fails, the login
      // page is the right place to retry.
      if (e instanceof AuthError) redirect("/login");
      throw e;
    }
  }

  if (!isSetupEnabled()) {
    return (
      <AuthCard brand={t("Pasokh")} title={t("Set up Pasokh")} subtitle={t("Setup is locked.")}>
        <p className="text-sm text-muted">
          {t("Set SETUP_TOKEN in the server's .env file (at least 16 random characters), restart Pasokh, and reload this page.")}
        </p>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      brand={t("Pasokh")}
      title={t("Set up Pasokh")}
      subtitle={t("Create the owner account for this server. You will use this email and password to sign in.")}
    >
      <form action={completeSetup} className="space-y-5">
        <FormError message={errorKey ? t(errorKey) : null} />
        <Field
          id="setupToken"
          label={t("Setup token")}
          type="password"
          dir="ltr"
          required
          autoComplete="off"
          hint={t("The SETUP_TOKEN value from the server's .env file.")}
        />
        <Field id="name" label={t("Your name")} autoComplete="name" />
        <Field id="workspace" label={t("Business or page name")} placeholder={t("e.g. My Shop")} />
        <Field id="email" label={t("Email")} type="email" dir="ltr" required autoComplete="email" />
        <Field
          id="password"
          label={t("Password")}
          type="password"
          dir="ltr"
          required
          minLength={8}
          autoComplete="new-password"
          hint={t("At least 8 characters.")}
        />
        <Field id="confirm" label={t("Repeat password")} type="password" dir="ltr" required minLength={8} autoComplete="new-password" />
        <SubmitButton>{t("Create account and continue")}</SubmitButton>
      </form>
    </AuthCard>
  );
}

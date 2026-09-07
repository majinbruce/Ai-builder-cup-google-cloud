import { config } from "../../config/index.ts";

/**
 * The two emails auth actually sends: verify your address, and reset your
 * password.
 *
 * They live here rather than inline in auth.factory.ts because they are
 * *content*, and the factory is about behaviour — mixing the two means every
 * copy tweak is a diff against your auth configuration. This is also the file a
 * new project is expected to edit: change the wording and the colours here and
 * nothing about the auth wiring moves.
 *
 * Deliberately dependency-free. No MJML, no Handlebars, no React Email — a
 * boilerplate should not pick your template engine, and two transactional
 * emails do not justify one. Everything below is plain string building.
 *
 * Written to the constraints email clients actually impose, which are not the
 * constraints of a web page:
 *
 *   - Table-based layout with inline styles. Gmail strips <style> blocks, and
 *     Outlook's renderer predates flexbox and grid by about a decade.
 *   - Every colour is stated explicitly. Clients do not inherit yours.
 *   - The CTA button is a padded <a>, not an <img> and not a <button> — images
 *     are blocked by default and buttons do not navigate from an email.
 *   - The raw URL is ALWAYS printed under the button. Corporate mail scanners
 *     rewrite or strip links, and this is the user's only fallback.
 *   - A plain-text alternative is always sent alongside the HTML.
 */

export interface AuthEmail {
  subject: string;
  text: string;
  html: string;
}

interface TemplateInput {
  /** The recipient's display name. UNTRUSTED — they chose it at sign-up. */
  name: string;
  /** The action link, built by Better Auth from BETTER_AUTH_URL. */
  url: string;
}

/**
 * Escapes the five characters that can break out of HTML text or a quoted
 * attribute.
 *
 * This is not decorative. `name` is whatever the user typed at sign-up, and it
 * is interpolated into markup that gets delivered to their inbox — and, in the
 * account-linking case, to an inbox that may not be theirs. Mail clients are
 * inconsistent about how much HTML they execute; the correct assumption is that
 * unescaped user input in an email body is an injection vector.
 */
export const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/** Palette. One place to rebrand both emails. */
const THEME = {
  bg: "#f4f6f5",
  card: "#ffffff",
  ink: "#141d1b",
  muted: "#5c6a66",
  faint: "#8a9793",
  rule: "#dde4e1",
  accent: "#0e6b65",
  accentInk: "#ffffff",
} as const;

interface LayoutInput {
  heading: string;
  greeting: string;
  lead: string;
  ctaLabel: string;
  url: string;
  expiry: string;
  footnote: string;
}

const layout = ({
  heading,
  greeting,
  lead,
  ctaLabel,
  url,
  expiry,
  footnote,
}: LayoutInput): string => {
  const appName = escapeHtml(config.auth.appName);
  const safeUrl = escapeHtml(url);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(heading)}</title>
</head>
<body style="margin:0;padding:0;background-color:${THEME.bg};">
  <!-- Preheader: the grey line shown next to the subject in most inboxes.
       Hidden in the body itself; without it clients show the first visible
       words, which would be the app name. -->
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(lead)}</div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${THEME.bg};padding:32px 12px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:480px;background-color:${THEME.card};border:1px solid ${THEME.rule};border-radius:6px;">
          <tr>
            <td style="padding:28px 32px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:13px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:${THEME.accent};">
              ${appName}
            </td>
          </tr>
          <tr>
            <td style="padding:16px 32px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:22px;line-height:1.3;font-weight:600;color:${THEME.ink};">
              ${escapeHtml(heading)}
            </td>
          </tr>
          <tr>
            <td style="padding:16px 32px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:${THEME.muted};">
              ${escapeHtml(greeting)}<br><br>${escapeHtml(lead)}
            </td>
          </tr>
          <tr>
            <td style="padding:24px 32px 0;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="background-color:${THEME.accent};border-radius:5px;">
                    <a href="${safeUrl}" style="display:inline-block;padding:12px 24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;font-weight:600;color:${THEME.accentInk};text-decoration:none;">${escapeHtml(ctaLabel)}</a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:20px 32px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:13px;line-height:1.6;color:${THEME.faint};">
              If the button does not work, copy this link into your browser:<br>
              <a href="${safeUrl}" style="color:${THEME.accent};word-break:break-all;">${safeUrl}</a>
            </td>
          </tr>
          <tr>
            <td style="padding:20px 32px 28px;">
              <div style="border-top:1px solid ${THEME.rule};padding-top:16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:12px;line-height:1.6;color:${THEME.faint};">
                ${escapeHtml(expiry)}<br>${escapeHtml(footnote)}
              </div>
            </td>
          </tr>
        </table>
        <div style="max-width:480px;padding:16px 4px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:11px;color:${THEME.faint};text-align:center;">
          Sent by ${appName}. This is an automated message — replies are not monitored.
        </div>
      </td>
    </tr>
  </table>
</body>
</html>`;
};

/**
 * The plain-text half. Not an afterthought: some clients render it by
 * preference, some users force it, and spam filters treat an HTML-only message
 * as a signal. It carries exactly the same link.
 */
const plain = ({
  greeting,
  lead,
  url,
  expiry,
  footnote,
}: Omit<LayoutInput, "heading" | "ctaLabel">): string =>
  [
    greeting,
    "",
    lead,
    "",
    url,
    "",
    expiry,
    footnote,
    "",
    `— ${config.auth.appName}`,
  ].join("\n");

const greet = (name: string): string => {
  const trimmed = name.trim();
  return trimmed ? `Hi ${trimmed},` : "Hi,";
};

export const verificationEmail = ({ name, url }: TemplateInput): AuthEmail => {
  const greeting = greet(name);
  const lead = `Confirm this email address to finish setting up your ${config.auth.appName} account.`;
  const expiry = "This link expires in 1 hour.";
  const footnote = "If you did not create an account, you can ignore this email.";

  return {
    subject: `Confirm your email address`,
    text: plain({ greeting, lead, url, expiry, footnote }),
    html: layout({
      heading: "Confirm your email address",
      greeting,
      lead,
      ctaLabel: "Confirm email address",
      url,
      expiry,
      footnote,
    }),
  };
};

export const passwordResetEmail = ({ name, url }: TemplateInput): AuthEmail => {
  const greeting = greet(name);
  const lead = "Use the link below to choose a new password.";
  const expiry = "This link expires in 1 hour and can only be used once.";
  /**
   * Worth being explicit about: a reset email is the one a user receives when
   * someone *else* may be trying to take their account, so it has to say
   * plainly that ignoring it is safe and changes nothing.
   */
  const footnote =
    "If you did not request a password reset, ignore this email — your password will not change.";

  return {
    subject: "Reset your password",
    text: plain({ greeting, lead, url, expiry, footnote }),
    html: layout({
      heading: "Reset your password",
      greeting,
      lead,
      ctaLabel: "Choose a new password",
      url,
      expiry,
      footnote,
    }),
  };
};

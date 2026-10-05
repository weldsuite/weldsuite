import type { ReactNode } from "react";
import {
  Body,
  Container,
  Head,
  Html,
  Img,
  Link,
  Preview,
  Section,
  Text,
} from "@react-email/components";
import { logoUrlOf, type EmailBrand } from "../brand";
import { emailStrings, rich, type EmailLocale } from "../i18n";
import { theme } from "../theme";

export interface EmailLayoutProps {
  brand: EmailBrand;
  locale: EmailLocale;
  /** Inbox preview line (hidden in the body). */
  preview: string;
  /** Small print in the footer, specific to the email ("If you didn't expect…"). */
  footer?: ReactNode;
  children: ReactNode;
}

const { color, font, size, space, lineHeight } = theme;

/**
 * The one layout every system email uses: a single narrow column on white, the
 * brand's logo on top, the content, and a quiet footer under a hairline.
 * Templates only fill the content.
 */
export function EmailLayout({
  brand,
  locale,
  preview,
  footer,
  children,
}: EmailLayoutProps) {
  const t = emailStrings(locale);
  // White-label portals can drop the "Sent via WeldSuite" line.
  const showWeldSuite = !(
    brand.kind === "workspace" && brand.poweredBy === false
  );

  return (
    <Html lang={locale} dir="ltr">
      <Head>
        <meta name="color-scheme" content="light" />
        <meta name="supported-color-schemes" content="light" />
      </Head>
      <Preview>{preview}</Preview>
      <Body
        style={{
          margin: 0,
          padding: 0,
          backgroundColor: color.page,
          fontFamily: font.family,
          WebkitFontSmoothing: "antialiased",
        }}
      >
        <Container
          style={{
            width: "100%",
            maxWidth: theme.width,
            margin: "0 auto",
            padding: `${space.pageY}px ${space.pageX}px`,
          }}
        >
          <Logo brand={brand} />
          <Section>{children}</Section>
          {footer || showWeldSuite ? (
            <Section
              style={{
                marginTop: space.text,
                paddingTop: space.block,
                borderTop: `1px solid ${color.border}`,
              }}
            >
              {footer ? <Text style={footerText}>{footer}</Text> : null}
              {showWeldSuite ? (
                <Text style={footerText}>
                  {brand.kind === "workspace" ? (
                    rich(t.layout.sentVia, {
                      product: (
                        <Link href={theme.links.weldsuite} style={footerLink}>
                          WeldSuite
                        </Link>
                      ),
                    })
                  ) : (
                    <Link href={theme.links.weldsuite} style={footerLink}>
                      WeldSuite
                    </Link>
                  )}
                </Text>
              ) : null}
            </Section>
          ) : null}
        </Container>
      </Body>
    </Html>
  );
}

const footerText = {
  margin: "0 0 8px",
  fontSize: size.tiny,
  lineHeight: lineHeight.body,
  color: color.subtle,
};

const footerLink = { color: color.subtle, textDecoration: "underline" };

function Logo({ brand }: { brand: EmailBrand }) {
  const wrapper = { marginBottom: space.block + 16 };

  if (brand.kind === "workspace") {
    const logoUrl = logoUrlOf(brand);
    return (
      <Section style={wrapper}>
        {logoUrl ? (
          <Img
            src={logoUrl}
            alt={brand.name}
            height={theme.workspaceLogoHeight}
            style={{
              height: theme.workspaceLogoHeight,
              width: "auto",
              maxWidth: 180,
              border: 0,
            }}
          />
        ) : (
          <Text
            style={{
              margin: 0,
              fontSize: size.body,
              fontWeight: 600,
              letterSpacing: "-0.01em",
              color: color.ink,
            }}
          >
            {brand.name}
          </Text>
        )}
      </Section>
    );
  }

  return (
    <Section style={wrapper}>
      <Img
        src={theme.logo.url}
        alt="WeldSuite"
        width={theme.logo.width}
        height={theme.logo.height}
        style={{ display: "block", border: 0 }}
      />
    </Section>
  );
}

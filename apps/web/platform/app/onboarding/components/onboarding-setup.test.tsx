import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { common } from "../../../../../../packages/core/i18n/src/locales/en/common";
import { OnboardingSetup, type OnboardingSetupProps } from "./onboarding-setup";
import { OnboardingWizard } from "./onboarding-wizard";

const mocks = vi.hoisted(() => ({
  complete: vi.fn(),
  setActive: vi.fn(),
  track: vi.fn(),
}));
vi.mock("@/lib/i18n", () => ({ getTranslations: () => common }));
vi.mock("@clerk/clerk-react", () => ({
  useOrganizationList: () => ({ setActive: mocks.setActive }),
}));
vi.mock("@/hooks/use-onboarding", () => ({
  useCompleteOnboarding: () => ({ mutateAsync: mocks.complete }),
}));
vi.mock("@/lib/analytics", () => ({ track: mocks.track }));
vi.mock("./provisioning-screen", () => ({
  ProvisioningScreen: () => <p>Provisioning started</p>,
}));

const props: OnboardingSetupProps = {
  initialUserInfo: { firstName: "", lastName: "", email: "alex@example.com" },
  initialOrgInfo: null,
  availableApps: [
    {
      code: "crm",
      name: "CRM",
      description: "",
      category: "",
      icon: "Users",
      path: "/crm",
    },
  ],
  detectedCountry: "NL",
  defaultRegion: "aws-eu-central-1",
  onSubmit: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("quick workspace setup", () => {
  it("requires only a trimmed workspace name when the catalog is unavailable", async () => {
    const user = userEvent.setup();
    render(<OnboardingSetup {...props} availableApps={[]} />);
    const submit = screen.getByRole("button", { name: "Create workspace" });
    expect(submit).toBeDisabled();
    await user.type(screen.getByLabelText("Workspace name"), "   ");
    expect(submit).toBeDisabled();
    await user.type(screen.getByLabelText("Workspace name"), "Acme  ");
    await user.click(submit);
    expect(props.onSubmit).toHaveBeenCalledWith({
      organizationName: "Acme",
      country: "NL",
      region: "aws-eu-central-1",
      selectedApps: [],
    });
    expect(screen.queryByLabelText("First name")).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText("How did you find us?"),
    ).not.toBeInTheDocument();
  });

  it("preselects WeldCRM over the other apps in the catalog", async () => {
    const user = userEvent.setup();
    render(
      <OnboardingSetup
        {...props}
        availableApps={[
          { ...props.availableApps[0], code: "mail", name: "Mail" },
          { ...props.availableApps[0], code: "crm", name: "CRM" },
        ]}
      />,
    );
    await user.click(screen.getByText("Choose apps"));
    const [mail, crm] = screen.getAllByTestId("onboarding-app-btn");
    expect(crm).toHaveAttribute("aria-pressed", "true");
    expect(mail).toHaveAttribute("aria-pressed", "false");
  });

  it("updates suggested regions but preserves an explicit storage choice", async () => {
    const user = userEvent.setup();
    render(<OnboardingSetup {...props} />);
    await user.click(screen.getByText("Country and data storage"));
    await user.selectOptions(screen.getByLabelText("Country"), "US");
    expect(screen.getByLabelText("Data storage region")).toHaveValue(
      "aws-us-east-1",
    );
    await user.selectOptions(
      screen.getByLabelText("Data storage region"),
      "aws-eu-west-2",
    );
    await user.selectOptions(screen.getByLabelText("Country"), "AU");
    expect(screen.getByLabelText("Data storage region")).toHaveValue(
      "aws-eu-west-2",
    );
  });

  it("submits the preselected app and blocks submission once it is deselected", async () => {
    const user = userEvent.setup();
    render(<OnboardingSetup {...props} />);
    await user.type(screen.getByLabelText("Workspace name"), "Acme");
    await user.click(screen.getByText("Choose apps"));
    const app = screen.getByTestId("onboarding-app-btn");
    expect(app).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "Create workspace" }));
    expect(props.onSubmit).toHaveBeenLastCalledWith(
      expect.objectContaining({ selectedApps: ["crm"] }),
    );
    app.focus();
    await user.keyboard(" ");
    expect(app).toHaveAttribute("aria-pressed", "false");
    expect(
      screen.getByRole("button", { name: "Create workspace" }),
    ).toBeDisabled();
    expect(
      screen.getByText(
        "Pick at least one app to start with. You can add more later from the App Store.",
      ),
    ).toBeInTheDocument();
  });

  it("disables all inputs and blocks form submission while saving", () => {
    render(
      <OnboardingSetup
        {...props}
        initialOrgInfo={{ id: "org", name: "Acme" }}
        isSubmitting
      />,
    );
    expect(screen.getByLabelText("Workspace name")).toBeDisabled();
    fireEvent.submit(screen.getByLabelText("Workspace name").closest("form")!);
    expect(props.onSubmit).not.toHaveBeenCalled();
  });
});

describe("workspace creation handoff", () => {
  it("reuses profile data, omits optional metadata, and hands off after org activation", async () => {
    const user = userEvent.setup();
    mocks.complete.mockResolvedValue({
      data: { success: true, clerkOrgId: "org_new" },
    });
    mocks.setActive.mockResolvedValue(undefined);
    render(
      <OnboardingWizard
        {...props}
        initialUserInfo={{
          ...props.initialUserInfo,
          firstName: "Alex",
          lastName: "Morgan",
        }}
      />,
    );
    await user.type(screen.getByLabelText("Workspace name"), "Acme");
    await user.click(screen.getByRole("button", { name: "Create workspace" }));
    expect(mocks.complete).toHaveBeenCalledWith({
      organizationName: "Acme",
      country: "NL",
      region: "aws-eu-central-1",
      selectedApps: ["crm"],
      firstName: "Alex",
      lastName: "Morgan",
    });
    expect(mocks.setActive).toHaveBeenCalledWith({ organization: "org_new" });
    expect(await screen.findByText("Provisioning started")).toBeInTheDocument();
  });

  it("retains input after failure and permits retry without duplicate pending requests", async () => {
    const user = userEvent.setup();
    mocks.complete.mockRejectedValueOnce(new Error("Please try again"));
    render(<OnboardingWizard {...props} />);
    await user.type(screen.getByLabelText("Workspace name"), "Acme");
    await user.click(screen.getByRole("button", { name: "Create workspace" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Please try again",
    );
    expect(screen.getByLabelText("Workspace name")).toHaveValue("Acme");
    mocks.complete.mockReturnValue(new Promise(() => {}));
    await user.click(screen.getByRole("button", { name: "Create workspace" }));
    fireEvent.submit(screen.getByLabelText("Workspace name").closest("form")!);
    await waitFor(() => expect(mocks.complete).toHaveBeenCalledTimes(2));
    expect(screen.getByLabelText("Workspace name")).toBeDisabled();
  });
});

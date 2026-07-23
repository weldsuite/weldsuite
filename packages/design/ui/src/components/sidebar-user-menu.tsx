"use client";

import { useState } from "react";
import {
  User,
  Settings,
  LogOut,
  ChevronsUpDown,
  Check,
  Plus,
  Building2,
  Mail,
  MessageSquare,
  Star,
} from "lucide-react";
import { cn } from "../lib/utils";
import { Button } from "./button";
import { Avatar, AvatarFallback, AvatarImage } from "./avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuPortal,
} from "./dropdown-menu";
import {
  StatusDot,
  STATUS_LABELS,
  PRESENCE_STATUSES,
  type PresenceStatus,
} from "./status-dot";
import { CustomStatusDialog, type CustomStatusValue } from "./custom-status-dialog";

export interface UserInfo {
  name?: string;
  email?: string;
  avatar?: string;
}

export interface Workspace {
  id: string;
  name: string;
  slug?: string;
}

export interface EmailAccount {
  id: string;
  email: string;
  displayName?: string;
}

/** Current presence value as the menu renders it. */
export interface PresenceValue {
  status: PresenceStatus | string;
  statusText?: string;
  statusEmoji?: string;
}

/**
 * Optional presence wiring. When provided, the menu shows a status indicator
 * on the avatar plus a status picker (and a "Set custom status..." dialog).
 * When omitted, the menu behaves exactly as before — no presence UI renders.
 *
 * Decoupled from any presence context: the consumer injects the current
 * status and a setter. The platform passes these from its PresenceProvider.
 */
export interface SidebarUserMenuPresence {
  /**
   * Current presence; `null`/`undefined` hides the avatar status dot.
   *
   * `status` is typed as `string` (not the package's `PresenceStatus` union)
   * so consumers with their own status union — e.g. the platform's
   * `UserPresence` — are structurally assignable without a cast.
   */
  myStatus?: { status: string; statusText?: string; statusEmoji?: string } | null;
  /**
   * Persist a status change (status + optional custom text/emoji). `status`
   * is `string` so a consumer setter typed with a narrower union (e.g.
   * `(status: PresenceStatus, ...) => void`) is assignable here.
   *
   * Declared as a METHOD (not an arrow property) on purpose: method
   * parameters are checked bivariantly, so a consumer whose setter only
   * accepts a narrow `PresenceStatus` union is assignable to this wider
   * `string` parameter. An arrow-property type would be checked
   * contravariantly under `strictFunctionTypes` and reject that.
   */
  setMyStatus(
    status: string,
    statusText?: string,
    statusEmoji?: string,
  ): void | Promise<void>;
  /** Override the selectable presets. Defaults to the standard five. */
  statusOptions?: (PresenceStatus | string)[];
  /** Localized labels for each status value. Defaults to English. */
  statusLabels?: Record<string, string>;
  /** "Set custom status..." menu item label. */
  customStatusLabel?: string;
}

export interface SidebarUserMenuProps {
  user?: UserInfo;
  currentWorkspace?: Workspace | null;
  workspaces?: Workspace[];
  onWorkspaceSwitch?: (workspaceId: string) => void;
  onWorkspaceCreate?: () => void;

  // Email account switching (for mail module)
  currentEmailAccount?: EmailAccount | null;
  emailAccounts?: EmailAccount[];
  onEmailAccountSwitch?: (accountId: string) => void;
  onEmailAccountAdd?: () => void;
  /** Currently-default email account id (for the "set as default" star toggle). */
  defaultEmailAccountId?: string | null;
  /** When provided, each email account shows a star to set/unset it as default. */
  onSetDefaultEmailAccount?: (accountId: string | null) => void;
  /** Tooltip/label for the "set as default" action. */
  setDefaultLabel?: string;
  /** Tooltip/label shown on the account that is currently default. */
  defaultLabel?: string;

  onSignOut?: () => void;
  onSettings?: () => void;
  collapsed?: boolean;

  /**
   * Optional presence integration. When provided, renders the avatar status
   * dot, a status picker submenu, and the custom-status dialog. When omitted,
   * no presence UI appears and behavior is unchanged.
   */
  presence?: SidebarUserMenuPresence;
}

export function SidebarUserMenu({
  user,
  currentWorkspace,
  workspaces = [],
  onWorkspaceSwitch,
  onWorkspaceCreate,
  currentEmailAccount,
  emailAccounts = [],
  onEmailAccountSwitch,
  onEmailAccountAdd,
  defaultEmailAccountId,
  onSetDefaultEmailAccount,
  setDefaultLabel = "Set as default",
  defaultLabel = "Default",
  onSignOut,
  onSettings,
  collapsed = false,
  presence,
}: SidebarUserMenuProps) {
  const [open, setOpen] = useState(false);
  const [showCustomStatus, setShowCustomStatus] = useState(false);

  const myStatus = presence?.myStatus;
  const setMyStatus = presence?.setMyStatus;
  const statusOptions = presence?.statusOptions ?? PRESENCE_STATUSES;
  const statusLabels = presence?.statusLabels ?? STATUS_LABELS;
  const customStatusLabel = presence?.customStatusLabel ?? "Set custom status...";
  const labels: Record<string, string> = statusLabels;
  const labelFor = (status?: PresenceStatus | string) =>
    labels[(status as string) || "offline"] ?? labels["offline"];

  const customStatusValue: CustomStatusValue = {
    statusText: myStatus?.statusText,
    statusEmoji: myStatus?.statusEmoji,
  };

  // Shared status-picker submenu (collapsed + expanded). Only rendered when a
  // setter is injected via the `presence` prop.
  const statusPicker = setMyStatus ? (
    <>
      <DropdownMenuSub>
        <DropdownMenuSubTrigger className="gap-2">
          <StatusDot status={myStatus?.status} size="sm" />
          <span>{labelFor(myStatus?.status)}</span>
        </DropdownMenuSubTrigger>
        <DropdownMenuPortal>
          <DropdownMenuSubContent>
            {statusOptions.map((status) => (
              <DropdownMenuItem
                key={status}
                onClick={() =>
                  setMyStatus(status, myStatus?.statusText, myStatus?.statusEmoji)
                }
                className="gap-2"
              >
                <StatusDot status={status} size="sm" />
                <span className="flex-1">{labelFor(status)}</span>
                {myStatus?.status === status && <Check className="h-4 w-4" />}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => {
                setOpen(false);
                setShowCustomStatus(true);
              }}
              className="gap-2"
            >
              <MessageSquare className="h-3.5 w-3.5" />
              <span>{customStatusLabel}</span>
            </DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuPortal>
      </DropdownMenuSub>
      <DropdownMenuSeparator />
    </>
  ) : null;

  // Avatar overlay status dot, shown only when presence reports a status.
  const statusIndicator = myStatus ? (
    <StatusDot
      status={myStatus.status}
      showTooltip
      className="absolute -bottom-0.5 -right-0.5 h-[11px] w-[11px] border-2"
    />
  ) : null;

  const userInitials = user?.name
    ?.split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase()
    .slice(0, 2) || "U";

  if (collapsed) {
    return (
      <>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            className="h-10 w-10 rounded-full p-0"
          >
            <div className="relative">
              <Avatar className="h-6 w-6">
                <AvatarImage src={user?.avatar} alt={user?.name} />
                <AvatarFallback>{userInitials}</AvatarFallback>
              </Avatar>
              {statusIndicator}
            </div>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72">
          <DropdownMenuLabel className="font-normal">
            <div className="flex flex-col space-y-1">
              <p className="text-sm font-medium leading-none">{user?.name || "User"}</p>
              <p className="text-xs leading-none text-muted-foreground">
                {user?.email || "user@example.com"}
              </p>
            </div>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />

          {/* Presence Status Picker */}
          {statusPicker}

          {/* Email Account Switcher in Collapsed Mode */}
          {emailAccounts.length > 0 && (
            <>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <Mail className="mr-2 h-4 w-4" />
                  <span className="truncate">
                    {currentEmailAccount?.email || "Select Account"}
                  </span>
                </DropdownMenuSubTrigger>
                <DropdownMenuPortal>
                  <DropdownMenuSubContent>
                    {emailAccounts.map((account) => (
                      <DropdownMenuItem
                        key={account.id}
                        onClick={() => onEmailAccountSwitch?.(account.id)}
                      >
                        <Check
                          className={cn(
                            "mr-2 h-4 w-4",
                            currentEmailAccount?.id === account.id
                              ? "opacity-100"
                              : "opacity-0"
                          )}
                        />
                        <div className="flex flex-col">
                          <span className="text-sm">{account.email}</span>
                          {account.displayName && (
                            <span className="text-xs text-muted-foreground">
                              {account.displayName}
                            </span>
                          )}
                        </div>
                        {onSetDefaultEmailAccount && (
                          <button
                            type="button"
                            title={defaultEmailAccountId === account.id ? defaultLabel : setDefaultLabel}
                            aria-label={defaultEmailAccountId === account.id ? defaultLabel : setDefaultLabel}
                            aria-pressed={defaultEmailAccountId === account.id}
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              onSetDefaultEmailAccount(account.id);
                            }}
                            className="ml-auto flex h-6 w-6 shrink-0 items-center justify-center rounded-sm hover:bg-accent-foreground/10"
                          >
                            <Star
                              className={cn(
                                "h-3.5 w-3.5",
                                defaultEmailAccountId === account.id
                                  ? "fill-yellow-400 text-yellow-400"
                                  : "text-muted-foreground"
                              )}
                            />
                          </button>
                        )}
                      </DropdownMenuItem>
                    ))}
                    {onEmailAccountAdd && (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onClick={onEmailAccountAdd}>
                          <Plus className="mr-2 h-4 w-4" />
                          Add Account
                        </DropdownMenuItem>
                      </>
                    )}
                  </DropdownMenuSubContent>
                </DropdownMenuPortal>
              </DropdownMenuSub>
              <DropdownMenuSeparator />
            </>
          )}

          {/* Workspace Switcher in Collapsed Mode */}
          {(workspaces.length > 0 || onWorkspaceCreate) && (
            <>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <Building2 className="mr-2 h-4 w-4" />
                  <span className="truncate">
                    {currentWorkspace?.name || "Workspace"}
                  </span>
                </DropdownMenuSubTrigger>
                <DropdownMenuPortal>
                  <DropdownMenuSubContent>
                    {workspaces.length > 0 && workspaces.map((workspace) => (
                      <DropdownMenuItem
                        key={workspace.id}
                        onClick={() => onWorkspaceSwitch?.(workspace.id)}
                      >
                        <Check
                          className={cn(
                            "mr-2 h-4 w-4",
                            currentWorkspace?.id === workspace.id
                              ? "opacity-100"
                              : "opacity-0"
                          )}
                        />
                        {workspace.name}
                      </DropdownMenuItem>
                    ))}
                    {workspaces.length > 0 && onWorkspaceCreate && <DropdownMenuSeparator />}
                    {onWorkspaceCreate && (
                      <DropdownMenuItem onClick={onWorkspaceCreate}>
                        <Plus className="mr-2 h-4 w-4" />
                        Create Workspace
                      </DropdownMenuItem>
                    )}
                  </DropdownMenuSubContent>
                </DropdownMenuPortal>
              </DropdownMenuSub>
              <DropdownMenuSeparator />
            </>
          )}
          
          {onSettings && (
            <DropdownMenuItem onClick={onSettings}>
              <Settings className="mr-2 h-4 w-4" />
              <span>Settings</span>
              <span className="ml-auto text-xs text-muted-foreground">⌘,</span>
            </DropdownMenuItem>
          )}
          {onSignOut && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={onSignOut}>
                <LogOut className="mr-2 h-4 w-4" />
                Sign out
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <CustomStatusDialog
        open={showCustomStatus}
        onOpenChange={setShowCustomStatus}
        value={customStatusValue}
        onSave={({ statusText, statusEmoji }) =>
          setMyStatus?.(myStatus?.status || "online", statusText, statusEmoji)
        }
      />
      </>
    );
  }

  return (
    <>
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className="w-full justify-start gap-2 px-2"
        >
          <div className="relative flex-shrink-0">
            <Avatar className="h-6 w-6">
              <AvatarImage src={user?.avatar} alt={user?.name} />
              <AvatarFallback>{userInitials}</AvatarFallback>
            </Avatar>
            {statusIndicator}
          </div>
          <div className="flex flex-1 flex-col items-start truncate">
            <span className="text-sm font-medium truncate w-full text-left">
              {user?.name || "User"}
            </span>
            <span className="text-xs text-muted-foreground truncate w-full text-left">
              {user?.email || "user@example.com"}
            </span>
          </div>
          <ChevronsUpDown className="h-4 w-4 opacity-50" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <DropdownMenuLabel className="font-normal">
          <div className="flex flex-col space-y-1">
            <p className="text-sm font-medium leading-none">{user?.name || "User"}</p>
            <p className="text-xs leading-none text-muted-foreground">
              {user?.email || "user@example.com"}
            </p>
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />

        {/* Presence Status Picker */}
        {statusPicker}

        {/* Email Account Switcher */}
        {emailAccounts.length > 0 && (
          <>
            <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
              Email Account
            </DropdownMenuLabel>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <Mail className="mr-2 h-4 w-4" />
                <span className="truncate">
                  {currentEmailAccount?.email || "Select Account"}
                </span>
              </DropdownMenuSubTrigger>
              <DropdownMenuPortal>
                <DropdownMenuSubContent>
                  {emailAccounts.map((account) => (
                    <DropdownMenuItem
                      key={account.id}
                      onClick={() => onEmailAccountSwitch?.(account.id)}
                    >
                      <Check
                        className={cn(
                          "mr-2 h-4 w-4",
                          currentEmailAccount?.id === account.id
                            ? "opacity-100"
                            : "opacity-0"
                        )}
                      />
                      <div className="flex flex-col">
                        <span className="text-sm">{account.email}</span>
                        {account.displayName && (
                          <span className="text-xs text-muted-foreground">
                            {account.displayName}
                          </span>
                        )}
                      </div>
                      {onSetDefaultEmailAccount && (
                        <button
                          type="button"
                          title={defaultEmailAccountId === account.id ? defaultLabel : setDefaultLabel}
                          aria-label={defaultEmailAccountId === account.id ? defaultLabel : setDefaultLabel}
                          aria-pressed={defaultEmailAccountId === account.id}
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            onSetDefaultEmailAccount(account.id);
                          }}
                          className="ml-auto flex h-6 w-6 shrink-0 items-center justify-center rounded-sm hover:bg-accent-foreground/10"
                        >
                          <Star
                            className={cn(
                              "h-3.5 w-3.5",
                              defaultEmailAccountId === account.id
                                ? "fill-yellow-400 text-yellow-400"
                                : "text-muted-foreground"
                            )}
                          />
                        </button>
                      )}
                    </DropdownMenuItem>
                  ))}
                  {onEmailAccountAdd && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onClick={onEmailAccountAdd}>
                        <Plus className="mr-2 h-4 w-4" />
                        Add Account
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuSubContent>
              </DropdownMenuPortal>
            </DropdownMenuSub>
            <DropdownMenuSeparator />
          </>
        )}

        {/* Workspace Switcher */}
        {(workspaces.length > 0 || onWorkspaceCreate) && (
          <>
            <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
              Workspace
            </DropdownMenuLabel>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <Building2 className="mr-2 h-4 w-4" />
                <span className="truncate">
                  {currentWorkspace?.name || "Workspace"}
                </span>
              </DropdownMenuSubTrigger>
              <DropdownMenuPortal>
                <DropdownMenuSubContent>
                  {workspaces.length > 0 && workspaces.map((workspace) => (
                    <DropdownMenuItem
                      key={workspace.id}
                      onClick={() => onWorkspaceSwitch?.(workspace.id)}
                    >
                      <Check
                        className={cn(
                          "mr-2 h-4 w-4",
                          currentWorkspace?.id === workspace.id
                            ? "opacity-100"
                            : "opacity-0"
                        )}
                      />
                      {workspace.name}
                    </DropdownMenuItem>
                  ))}
                  {workspaces.length > 0 && onWorkspaceCreate && <DropdownMenuSeparator />}
                  {onWorkspaceCreate && (
                    <DropdownMenuItem onClick={onWorkspaceCreate}>
                      <Plus className="mr-2 h-4 w-4" />
                      Create Workspace
                    </DropdownMenuItem>
                  )}
                </DropdownMenuSubContent>
              </DropdownMenuPortal>
            </DropdownMenuSub>
            <DropdownMenuSeparator />
          </>
        )}
        
        {onSettings && (
          <DropdownMenuItem onClick={onSettings}>
            <Settings className="mr-2 h-4 w-4" />
            <span>Settings</span>
            <span className="ml-auto text-xs text-muted-foreground">⌘,</span>
          </DropdownMenuItem>
        )}
        {onSignOut && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onSignOut}>
              <LogOut className="mr-2 h-4 w-4" />
              Sign out
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
    <CustomStatusDialog
      open={showCustomStatus}
      onOpenChange={setShowCustomStatus}
      value={customStatusValue}
      onSave={({ statusText, statusEmoji }) =>
        setMyStatus?.(myStatus?.status || "online", statusText, statusEmoji)
      }
    />
    </>
  );
}
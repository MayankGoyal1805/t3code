import {
  type EnvironmentId,
  type ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";

import { Button } from "../ui/button";
import { SettingsRow } from "./settingsLayout";
import { ProviderAuthenticationSection } from "./ProviderAuthenticationSection";

interface ProviderSetupSectionProps {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly instanceId: ProviderInstanceId;
  readonly provider: ServerProvider | undefined;
  /** The instance Gemini directory; empty means it shares ~/.gemini with the agy CLI. */
  readonly homePath?: string | undefined;
  readonly enabled: boolean;
  readonly readOnly: boolean;
  readonly onEnable: () => void;
}

export function readAntigravityHomePath(config: unknown): string {
  const value =
    config !== null && typeof config === "object" && "homePath" in config
      ? config.homePath
      : undefined;
  return typeof value === "string" ? value : "";
}

export function ProviderSetupSection(props: ProviderSetupSectionProps) {
  return (
    <section
      aria-label="Antigravity setup"
      className="@container/setup divide-y divide-border/50 text-xs [&_[data-slot=settings-row]]:rounded-none"
    >
      <SettingsRow
        className="@max-lg/setup:[&>div:first-child]:flex @max-lg/setup:[&>div:first-child]:items-stretch @max-lg/setup:[&>div:first-child]:gap-3"
        title="Environment"
        description="Device that runs this provider."
        control={
          <div className="flex min-w-0 flex-col gap-2 sm:items-end">
            <span className="text-muted-foreground [overflow-wrap:anywhere]">
              {props.environmentLabel}
            </span>
            {!props.enabled && !props.readOnly ? (
              <Button size="sm" variant="outline" onClick={props.onEnable}>
                Enable Antigravity
              </Button>
            ) : null}
          </div>
        }
      />
      {props.readOnly ? (
        <SettingsRow title="Setup unavailable" description="Provider setup is read-only." />
      ) : props.provider?.setup === undefined ? (
        <SettingsRow
          title="Update required"
          description="Update this environment to manage Antigravity."
        />
      ) : (
        <>
          {props.homePath?.trim() ? null : (
            <SettingsRow
              title="Sign-in storage"
              description="Shares its Google sign-in and conversations with the agy CLI. Signing out here signs the CLI out too. Set a Gemini directory to keep this instance separate."
            />
          )}
          <ProviderAuthenticationSection
            environmentId={props.environmentId}
            environmentLabel={props.environmentLabel}
            instanceId={props.instanceId}
            provider={props.provider}
            readOnly={false}
          />
        </>
      )}
    </section>
  );
}

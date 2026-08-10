import {
  PiSettings,
  type ProviderInstanceEnvironment,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export interface PiUsageConfiguration {
  readonly settings: PiSettings;
  readonly environment?: ProviderInstanceEnvironment;
}

const decodePiSettings = Schema.decodeUnknownOption(PiSettings);

/**
 * Selects every configured Pi instance using the same legacy/default precedence
 * as provider-instance hydration. Invalid instance configs are unavailable to
 * the Pi driver and therefore cannot identify a transcript directory here.
 */
export function collectPiUsageConfigurations(
  settings: ServerSettings,
): readonly PiUsageConfiguration[] {
  const configurations: PiUsageConfiguration[] = [];

  if (!("piAgent" in settings.providerInstances)) {
    configurations.push({ settings: settings.providers.piAgent });
  }

  for (const instance of Object.values(settings.providerInstances)) {
    if (instance.driver !== "piAgent") continue;
    const decoded = decodePiSettings(instance.config ?? {});
    if (Option.isNone(decoded)) continue;
    configurations.push({
      settings: {
        ...decoded.value,
        enabled: instance.enabled ?? decoded.value.enabled,
      },
      ...(instance.environment === undefined ? {} : { environment: instance.environment }),
    });
  }

  return configurations;
}

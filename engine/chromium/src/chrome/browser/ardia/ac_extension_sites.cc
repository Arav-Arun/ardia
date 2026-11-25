// Copyright 2026 Ardia. Apache-2.0.

#include "chrome/browser/ardia/ac_extension_sites_internal.h"

#include <memory>
#include <optional>
#include <string>
#include <utility>

#include "base/functional/bind.h"
#include "base/memory/weak_ptr.h"
#include "chrome/browser/profiles/profile.h"
#include "extensions/browser/extension_registry.h"
#include "extensions/browser/permissions/permissions_updater.h"
#include "extensions/browser/permissions_manager.h"
#include "extensions/common/extension.h"
#include "extensions/common/manifest_handlers/permissions_parser.h"
#include "extensions/common/permissions/api_permission_set.h"
#include "extensions/common/permissions/manifest_permission_set.h"
#include "extensions/common/permissions/permission_set.h"
#include "extensions/common/url_pattern.h"
#include "extensions/common/url_pattern_set.h"

namespace ardia::extension_sites_internal {
namespace {

std::optional<URLPattern> RuntimeSitePattern(const std::string& site) {
  URLPattern pattern(URLPattern::SCHEME_HTTP | URLPattern::SCHEME_HTTPS |
                     URLPattern::SCHEME_FILE);
  if (pattern.Parse(site) != URLPattern::ParseResult::kSuccess ||
      pattern.path() != "/*") {
    return std::nullopt;
  }
  return pattern;
}

extensions::PermissionSet HostPermissions(const URLPattern& pattern) {
  extensions::URLPatternSet hosts({pattern});
  extensions::URLPatternSet scriptable = hosts.Clone();
  return extensions::PermissionSet(extensions::APIPermissionSet(),
                                   extensions::ManifestPermissionSet(),
                                   std::move(hosts), std::move(scriptable));
}

void RestoreRemainingGrants(base::WeakPtr<Profile> profile,
                            const std::string& id,
                            Reply reply) {
  const extensions::Extension* extension =
      profile ? extensions::ExtensionRegistry::Get(profile.get())
                    ->GetExtensionById(id,
                                       extensions::ExtensionRegistry::EVERYTHING)
              : nullptr;
  if (!extension) {
    return reply.Ok();
  }
  std::unique_ptr<const extensions::PermissionSet> remaining =
      extensions::PermissionsManager::Get(profile.get())
          ->GetRuntimePermissionsFromPrefs(*extension);
  if (!remaining || remaining->effective_hosts().is_empty()) {
    return reply.Ok();
  }
  extensions::PermissionsUpdater(profile.get())
      .GrantRuntimePermissions(
          *extension,
          extensions::PermissionSet(extensions::APIPermissionSet(),
                                    extensions::ManifestPermissionSet(),
                                    remaining->explicit_hosts().Clone(),
                                    remaining->scriptable_hosts().Clone()),
          base::BindOnce([](Reply done) { done.Ok(); }, std::move(reply)));
}

}

std::string SiteProblem(Profile* profile,
                        const extensions::Extension& extension,
                        const std::string& site,
                        bool grant) {
  if (!extensions::PermissionsManager::Get(profile)->CanAffectExtension(
          extension)) {
    return "Can't change this extension's site access";
  }
  std::optional<URLPattern> pattern = RuntimeSitePattern(site);
  if (!pattern) {
    return "That isn't a site an extension can be given";
  }
  if (!grant) {
    return "";
  }
  extensions::PermissionSet asked = HostPermissions(*pattern);
  if (asked.ShouldWarnAllHosts(false)) {
    return "That covers every site. Choose On all sites instead";
  }
  std::unique_ptr<extensions::PermissionSet> requested =
      extensions::PermissionSet::CreateUnion(
          extensions::PermissionsParser::GetRequiredPermissions(&extension),
          extensions::PermissionsParser::GetOptionalPermissions(&extension));
  if (extensions::PermissionSet::CreateIntersection(
          asked, *requested,
          extensions::URLPatternSet::IntersectionBehavior::kDetailed)
          ->effective_hosts()
          .is_empty()) {
    return "This extension doesn't ask for that site";
  }
  return "";
}

void ChangeSite(Profile* profile,
                const extensions::Extension& extension,
                const std::string& site,
                bool grant,
                Reply reply) {
  extensions::PermissionsManager* manager =
      extensions::PermissionsManager::Get(profile);
  std::optional<URLPattern> pattern = RuntimeSitePattern(site);
  if (!pattern) {
    return reply.Error("That isn't a site an extension can be given");
  }
  if (grant) {
    extensions::PermissionsUpdater(profile).GrantRuntimePermissions(
        extension, HostPermissions(*pattern),
        base::BindOnce([](Reply done) { done.Ok(); }, std::move(reply)));
    return;
  }
  std::unique_ptr<const extensions::PermissionSet> granted =
      extensions::PermissionSet::CreateIntersection(
          HostPermissions(*pattern), *manager->GetRevokablePermissions(extension),
          extensions::URLPatternSet::IntersectionBehavior::kDetailed);
  if (granted->IsEmpty()) {
    return reply.Ok();
  }
  extensions::PermissionsUpdater(profile).RevokeRuntimePermissions(
      extension, *granted,
      base::BindOnce(&RestoreRemainingGrants, profile->GetWeakPtr(),
                     extension.id(), std::move(reply)));
}

}

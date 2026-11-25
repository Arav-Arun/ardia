// Copyright 2026 Ardia. Apache-2.0.

#include "chrome/browser/ardia/ac_extension_sites_internal.h"

#include <memory>
#include <optional>
#include <string>
#include <utility>

#include "base/functional/bind.h"
#include "chrome/browser/profiles/profile.h"
#include "extensions/browser/permissions/permissions_updater.h"
#include "extensions/browser/permissions_manager.h"
#include "extensions/common/extension.h"
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

}

void ChangeSite(Profile* profile,
                const extensions::Extension& extension,
                const std::string& site,
                bool grant,
                Reply reply) {
  extensions::PermissionsManager* manager =
      extensions::PermissionsManager::Get(profile);
  if (!manager->CanAffectExtension(extension)) {
    return reply.Error("Can't change this extension's site access");
  }
  std::optional<URLPattern> pattern = RuntimeSitePattern(site);
  if (!pattern) {
    return reply.Error("That isn't a site an extension can be given");
  }
  auto replied =
      base::BindOnce([](Reply done) { done.Ok(); }, std::move(reply));
  if (grant) {
    extensions::PermissionsUpdater(profile).GrantRuntimePermissions(
        extension, HostPermissions(*pattern), std::move(replied));
    return;
  }
  std::unique_ptr<const extensions::PermissionSet> granted =
      extensions::PermissionSet::CreateIntersection(
          HostPermissions(*pattern), *manager->GetRevokablePermissions(extension),
          extensions::URLPatternSet::IntersectionBehavior::kDetailed);
  if (granted->IsEmpty()) {
    return std::move(replied).Run();
  }
  extensions::PermissionsUpdater(profile).RevokeRuntimePermissions(
      extension, *granted, std::move(replied));
}

}

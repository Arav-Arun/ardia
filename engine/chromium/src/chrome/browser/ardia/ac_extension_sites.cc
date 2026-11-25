// Copyright 2026 Ardia. Apache-2.0.

#include "chrome/browser/ardia/ac_extension_sites_internal.h"

#include <memory>
#include <optional>
#include <string>
#include <utility>

#include "base/functional/bind.h"
#include "chrome/browser/profiles/profile.h"
#include "extensions/browser/permissions/scripting_permissions_modifier.h"
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
  if (extensions::PermissionSet::CreateIntersection(
          asked,
          extensions::PermissionsParser::GetRequiredPermissions(&extension),
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
  std::optional<URLPattern> pattern = RuntimeSitePattern(site);
  if (!pattern) {
    return reply.Error("That isn't a site an extension can be given");
  }
  auto done = base::BindOnce([](Reply sent) { sent.Ok(); }, std::move(reply));
  extensions::ScriptingPermissionsModifier modifier(profile, &extension);
  if (grant) {
    modifier.GrantHostPermission(*pattern, std::move(done));
  } else {
    modifier.RemoveHostPermissions(*pattern, std::move(done));
  }
}

}

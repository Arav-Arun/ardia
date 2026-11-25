// Copyright 2026 Ardia. Apache-2.0.

#include "chrome/browser/ardia/ac_extension_sites_internal.h"

#include <map>
#include <memory>
#include <optional>
#include <string>
#include <utility>

#include "base/containers/circular_deque.h"
#include "base/functional/bind.h"
#include "base/functional/callback_helpers.h"
#include "base/memory/weak_ptr.h"
#include "base/no_destructor.h"
#include "base/task/sequenced_task_runner.h"
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

void RestoreKeptGrants(base::WeakPtr<Profile> profile,
                       const std::string& id,
                       std::unique_ptr<extensions::PermissionSet> kept,
                       base::OnceCallback<void(Reply)> finish,
                       Reply reply) {
  const extensions::Extension* extension =
      profile ? extensions::ExtensionRegistry::Get(profile.get())
                    ->GetExtensionById(id,
                                       extensions::ExtensionRegistry::EVERYTHING)
              : nullptr;
  if (!extension || kept->effective_hosts().is_empty()) {
    return std::move(finish).Run(std::move(reply));
  }
  extensions::PermissionsUpdater(profile.get())
      .GrantRuntimePermissions(
          *extension, *kept, base::BindOnce(std::move(finish), std::move(reply)));
}

std::unique_ptr<extensions::PermissionSet> GrantsKeptAfterRemoving(
    const extensions::PermissionSet* stored,
    const URLPattern& removed) {
  extensions::URLPatternSet explicit_hosts;
  extensions::URLPatternSet scriptable_hosts;
  const std::string removed_text = removed.GetAsString();
  if (stored) {
    for (const URLPattern& host : stored->explicit_hosts()) {
      if (host.GetAsString() != removed_text) {
        explicit_hosts.AddPattern(host);
      }
    }
    for (const URLPattern& host : stored->scriptable_hosts()) {
      if (host.GetAsString() != removed_text) {
        scriptable_hosts.AddPattern(host);
      }
    }
  }
  return std::make_unique<extensions::PermissionSet>(
      extensions::APIPermissionSet(), extensions::ManifestPermissionSet(),
      std::move(explicit_hosts), std::move(scriptable_hosts));
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

namespace {

using Queued = std::map<std::string, base::circular_deque<base::OnceClosure>>;

Queued& Changing() {
  static base::NoDestructor<Queued> changing;
  return *changing;
}

void RunNext(const std::string& key) {
  auto it = Changing().find(key);
  if (it == Changing().end()) {
    return;
  }
  if (it->second.empty()) {
    Changing().erase(it);
    return;
  }
  base::OnceClosure next = std::move(it->second.front());
  it->second.pop_front();
  std::move(next).Run();
}

base::ScopedClosureRunner TurnFor(const std::string& key) {
  return base::ScopedClosureRunner(base::BindOnce(
      [](std::string key) {
        base::SequencedTaskRunner::GetCurrentDefault()->PostTask(
            FROM_HERE, base::BindOnce(&RunNext, std::move(key)));
      },
      key));
}

void Finish(base::ScopedClosureRunner, Reply reply) {
  reply.Ok();
}

void StartChange(base::WeakPtr<Profile> profile,
                 const std::string& id,
                 const std::string& site,
                 bool grant,
                 Reply reply,
                 base::ScopedClosureRunner turn) {
  const extensions::Extension* extension =
      profile ? extensions::ExtensionRegistry::Get(profile.get())
                    ->GetExtensionById(id,
                                       extensions::ExtensionRegistry::EVERYTHING)
              : nullptr;
  std::optional<URLPattern> pattern = RuntimeSitePattern(site);
  if (!extension) {
    return reply.Error("No such extension");
  }
  if (!pattern) {
    return reply.Error("That isn't a site an extension can be given");
  }
  extensions::PermissionsManager* manager =
      extensions::PermissionsManager::Get(profile.get());
  if (grant) {
    extensions::PermissionsUpdater(profile.get())
        .GrantRuntimePermissions(
            *extension, HostPermissions(*pattern),
            base::BindOnce(&Finish, std::move(turn), std::move(reply)));
    return;
  }
  std::unique_ptr<const extensions::PermissionSet> granted =
      extensions::PermissionSet::CreateIntersection(
          HostPermissions(*pattern),
          *manager->GetRevokablePermissions(*extension),
          extensions::URLPatternSet::IntersectionBehavior::kDetailed);
  if (granted->IsEmpty()) {
    return reply.Ok();
  }
  std::unique_ptr<const extensions::PermissionSet> stored =
      manager->GetRuntimePermissionsFromPrefs(*extension);
  extensions::PermissionsUpdater(profile.get())
      .RevokeRuntimePermissions(
          *extension, *granted,
          base::BindOnce(&RestoreKeptGrants, profile, id,
                         GrantsKeptAfterRemoving(stored.get(), *pattern),
                         base::BindOnce(&Finish, std::move(turn)),
                         std::move(reply)));
}

}

void ChangeSite(Profile* profile,
                const extensions::Extension& extension,
                const std::string& site,
                bool grant,
                Reply reply) {
  const std::string key = profile->GetPath().AsUTF8Unsafe() + "\n" +
                          (profile->IsOffTheRecord() ? "otr\n" : "") +
                          extension.id();
  auto change = base::BindOnce(&StartChange, profile->GetWeakPtr(),
                               extension.id(), site, grant, std::move(reply),
                               TurnFor(key));
  auto [it, idle] = Changing().try_emplace(key);
  if (!idle) {
    it->second.push_back(std::move(change));
    return;
  }
  std::move(change).Run();
}

}

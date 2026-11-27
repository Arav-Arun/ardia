#include "ardia/core/ac_feature_switches.h"

#include <string>
#include <string_view>

#include "base/allocator/partition_alloc_features.h"
#include "base/base_switches.h"
#include "base/command_line.h"
#include "base/feature_list.h"

namespace ardiacore {

void MergeFeatures(base::CommandLine* command_line, const char* list, std::string_view features) {
  const std::string current = command_line->GetSwitchValueASCII(list);
  command_line->RemoveSwitch(list);
  command_line->AppendSwitchASCII(list, current.empty() ? std::string(features)
                                                        : current + "," + std::string(features));
}

bool CommandLineDecidesFeature(const base::CommandLine& command_line, std::string_view feature) {
  for (const char* list : {switches::kEnableFeatures, switches::kDisableFeatures}) {
    const std::string value = command_line.GetSwitchValueASCII(list);
    for (std::string_view entry : base::FeatureList::SplitFeatureListString(value)) {
      std::string name;
      std::string study;
      std::string group;
      std::string params;
      if (!base::FeatureList::ParseEnableFeatureString(entry, &name, &study, &group, &params)) {
        return true;
      }
      std::string_view named = name;
      if (named.starts_with('*')) {
        named.remove_prefix(1);
      }
      if (named == feature) {
        return true;
      }
    }
  }
  return false;
}

void ReportDanglingUnretainedWithoutCrashing(base::CommandLine* command_line) {
  const std::string_view feature = base::features::kPartitionAllocUnretainedDanglingPtr.name;
  if (CommandLineDecidesFeature(*command_line, feature)) {
    return;
  }
  MergeFeatures(command_line, switches::kEnableFeatures,
                std::string(feature) + ":" + base::features::kUnretainedDanglingPtrModeParam.name +
                    "/dump_without_crashing");
}

}

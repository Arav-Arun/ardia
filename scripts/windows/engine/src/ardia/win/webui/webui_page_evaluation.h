#ifndef ARDIA_WIN_WEBUI_WEBUI_PAGE_EVALUATION_H_
#define ARDIA_WIN_WEBUI_WEBUI_PAGE_EVALUATION_H_

#include <optional>
#include <span>
#include <string>
#include <utility>

#include "ardia/linux/ac_linux_page_evaluation.h"
#include "ardia/linux/ac_linux_page_operations.h"
#include "base/values.h"

namespace ardia_win::webui_page {

struct PageReply {
  bool ok = false;
  base::Value value;
};

struct PageEvaluationStep {
  std::optional<std::string> script;
  PageReply refusal;
};

inline PageEvaluationStep PreparePageEvaluation(
    const base::ListValue* values,
    const ardiacore::LinuxPageDigest& digest,
    const ardiacore::LinuxPageJsonList& parse_list,
    std::span<const ardiacore::LinuxPageOperation> operations =
        ardiacore::kLinuxPageOperations) {
  if (!values || values->size() != 1 || !(*values)[0].is_string()) {
    return {std::nullopt,
            {false, base::Value("evaluate requires one script")}};
  }
  std::optional<std::string> script = ardiacore::LinuxPageEvaluationScript(
      (*values)[0].GetString(), digest, parse_list, operations);
  if (!script) {
    return {std::nullopt,
            {false, base::Value(base::DictValue()
                                    .Set("code", "ERR_PAGE_EVALUATION_REFUSED")
                                    .Set("message",
                                         "Ardia runs only its own page "
                                         "operations"))}};
  }
  return {std::move(script), {}};
}

inline PageReply PageEvaluationUnavailable() {
  return {true, base::Value()};
}

inline PageReply PageEvaluationAnswered(const base::Value& value) {
  std::optional<std::string> result =
      ardiacore::LinuxPageEvaluationResult(value);
  return {true, result ? base::Value(std::move(*result)) : base::Value()};
}

}

#endif

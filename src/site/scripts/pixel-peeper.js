const root = document.querySelector("[data-peeper]");

if (root) {
  const status = root.querySelector("[data-peeper-status]");
  const choices = root.querySelector("[data-peeper-choices]");
  const result = root.querySelector("[data-peeper-result]");
  let trials = [];
  let index = 0;
  let metricMatches = 0;

  const label = (position) => String.fromCharCode(65 + position);

  function showTrial() {
    const trial = trials[index];
    result.hidden = true;
    choices.replaceChildren();
    status.textContent = `Trial ${index + 1} of ${trials.length} · ${trial.axis}`;

    [...trial.options]
      .sort((a, b) => a.src.localeCompare(b.src))
      .forEach((option, position) => {
        const button = document.createElement("button");
        const image = document.createElement("img");
        const name = document.createElement("span");
        button.type = "button";
        button.className = "peeper__choice";
        image.src = option.src;
        image.alt = `Candidate ${label(position)}`;
        image.width = 320;
        image.height = 320;
        name.textContent = `Candidate ${label(position)}`;
        button.append(image, name);
        button.addEventListener("click", () => reveal(option, trial));
        choices.append(button);
      });
  }

  function reveal(chosen, trial) {
    const matched = Boolean(chosen.s2best);
    metricMatches += Number(matched);
    for (const [position, button] of [...choices.children].entries()) {
      const option = [...trial.options].sort((a, b) => a.src.localeCompare(b.src))[position];
      button.disabled = true;
      button.querySelector("span").textContent = `${option.label} · ${option.bytes.toLocaleString()} B`;
      if (option === chosen) button.dataset.chosen = "true";
    }
    result.replaceChildren();
    const copy = document.createElement("p");
    copy.textContent = matched
      ? `Your pick also leads SSIMULACRA2. Metric matches: ${metricMatches}/${index + 1}.`
      : `Your eye disagreed with SSIMULACRA2 here. Metric matches: ${metricMatches}/${index + 1}.`;
    result.append(copy);
    if (index + 1 < trials.length) {
      const next = document.createElement("button");
      next.type = "button";
      next.textContent = "Next trial";
      next.addEventListener("click", () => { index += 1; showTrial(); });
      result.append(next);
    }
    result.hidden = false;
  }

  fetch(root.dataset.manifest, { credentials: "omit" })
    .then((response) => {
      if (!response.ok) throw new Error(`manifest returned ${response.status}`);
      return response.json();
    })
    .then((data) => {
      trials = Array.isArray(data.trials) ? data.trials : [];
      if (!trials.length) throw new Error("manifest has no trials");
      showTrial();
    })
    .catch(() => {
      status.textContent = "The trial manifest could not be loaded.";
      const link = document.createElement("a");
      link.href = root.dataset.manifest;
      link.textContent = "Open the source data";
      choices.replaceChildren(link);
    });
}

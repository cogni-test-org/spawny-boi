// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { KnowledgeUseWhen } from "../src/index.js";

afterEach(cleanup);

describe("KnowledgeUseWhen", () => {
  it.each([
    undefined,
    null,
    "",
    " \n\t ",
  ])("omits an absent or blank trigger (%j)", (useWhen) => {
    const { container } = render(<KnowledgeUseWhen useWhen={useWhen} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("trims the trigger and leaves styling with the caller", () => {
    const { container } = render(
      <KnowledgeUseWhen
        useWhen="  reviewing deployment evidence  "
        className="node-subtitle"
      />
    );

    expect(container.querySelector("p")).toHaveTextContent(
      /^Use when: reviewing deployment evidence$/
    );
    expect(container.querySelector("p")).toHaveClass("node-subtitle");
  });

  it("renders markup-like triggers as plain text", () => {
    const trigger = '<img src=x onerror="alert(1)"> **review**';
    const { container } = render(<KnowledgeUseWhen useWhen={trigger} />);

    expect(
      screen.getByText((_, element) => element?.tagName === "P")
    ).toHaveTextContent(`Use when: ${trigger}`);
    expect(container.querySelector("img, script, strong")).toBeNull();
  });

  it("removes a previous trigger when the selected atom has none", () => {
    const { container, rerender } = render(
      <KnowledgeUseWhen useWhen="reviewing a repair" />
    );
    expect(screen.getByText("Use when:")).toBeInTheDocument();

    rerender(<KnowledgeUseWhen />);
    expect(container).toBeEmptyDOMElement();
  });
});

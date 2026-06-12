import { describe, expect, test } from "bun:test";
import { globIndexRange, matchGlob } from "../src/glob";

describe("matchGlob", () => {
  test("matches exact strings", () => {
    expect(matchGlob("foo", "foo")).toBe(true);
    expect(matchGlob("foo", "bar")).toBe(false);
  });

  test("matches * wildcard", () => {
    expect(matchGlob("*", "anything")).toBe(true);
    expect(matchGlob("session:*", "session:abc")).toBe(true);
    expect(matchGlob("session:*", "other:abc")).toBe(false);
  });

  test("matches ? wildcard", () => {
    expect(matchGlob("a?c", "abc")).toBe(true);
    expect(matchGlob("a?c", "ac")).toBe(false);
  });

  test("matches character classes", () => {
    expect(matchGlob("[abc]", "b")).toBe(true);
    expect(matchGlob("[abc]", "d")).toBe(false);
    expect(matchGlob("[a-z]", "m")).toBe(true);
  });

  test("supports backslash escape", () => {
    expect(matchGlob("a\\*b", "a*b")).toBe(true);
    expect(matchGlob("a\\*b", "axb")).toBe(false);
  });
});

describe("globIndexRange", () => {
  test("returns prefix for trailing star only", () => {
    expect(globIndexRange("session:*")).toEqual({ prefix: "session:" });
    expect(globIndexRange("*")).toEqual({ prefix: "" });
  });

  test("returns null when pattern has other glob syntax", () => {
    expect(globIndexRange("sess?on:*")).toBeNull();
    expect(globIndexRange("session:[a]*")).toBeNull();
  });

  test("treats trailing star as prefix range", () => {
    expect(globIndexRange("session*")).toEqual({ prefix: "session" });
  });
});

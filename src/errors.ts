import { Schema } from "effect";

/** The configuration file is missing, unreadable or invalid. */
export class ConfigInvalid extends Schema.TaggedError<ConfigInvalid>()("ConfigInvalid", { message: Schema.String }) {}

/** git refused or failed a command the engine needs (the index, a status). */
export class GitFailed extends Schema.TaggedError<GitFailed>()("GitFailed", { message: Schema.String }) {}

/** A process could not be started at all (not: it ran and failed, which is a verdict). */
export class SpawnFailed extends Schema.TaggedError<SpawnFailed>()("SpawnFailed", { message: Schema.String }) {}

/** A file the engine reads or writes (its own state, a report) failed. */
export class FileFailed extends Schema.TaggedError<FileFailed>()("FileFailed", { message: Schema.String }) {}

/** The remote verdict cache did not answer as expected. */
export class CacheUnavailable extends Schema.TaggedError<CacheUnavailable>()("CacheUnavailable", { message: Schema.String }) {}

/** The command line asks for something invalid (a shard out of range...). */
export class UsageInvalid extends Schema.TaggedError<UsageInvalid>()("UsageInvalid", { message: Schema.String }) {}

/** Some units failed: the run's verdict, exit 1. */
export class TestsFailed extends Schema.TaggedError<TestsFailed>()("TestsFailed", { count: Schema.Number }) {}

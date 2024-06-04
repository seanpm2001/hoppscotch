import {
  Environment,
  HoppCollection,
  HoppRESTHeader,
  HoppRESTParam,
  parseTemplateStringE,
} from "@hoppscotch/data";
import axios, { AxiosError } from "axios";
import chalk from "chalk";
import * as A from "fp-ts/Array";
import * as E from "fp-ts/Either";
import * as O from "fp-ts/Option";
import { pipe } from "fp-ts/function";
import * as S from "fp-ts/string";
import fs from "fs/promises";
import { round } from "lodash-es";

import { error } from "../types/errors";
import { DEFAULT_DURATION_PRECISION } from "./constants";
import { readJsonFile } from "./mutators";
import {
  WorkspaceCollection,
  WorkspaceEnvironment,
  transformWorkspaceCollection,
  transformWorkspaceEnvironment,
} from "./workspace-access";

/**
 * Generates template string (status + statusText) with specific color unicodes
 * based on type of status.
 * @param status Status code of a HTTP response.
 * @param statusText Status text of a HTTP response.
 * @returns Template string with related color unicodes.
 */
export const getColorStatusCode = (
  status: number | string,
  statusText: string
): string => {
  const statusCode = `${status == 0 ? "Error" : status} : ${statusText}`;

  if (status.toString().startsWith("2")) {
    return chalk.greenBright(statusCode);
  } else if (status.toString().startsWith("3")) {
    return chalk.yellowBright(statusCode);
  }

  return chalk.redBright(statusCode);
};

/**
 * Replaces all template-string with their effective ENV values to generate effective
 * request headers/parameters meta-data.
 * @param metaData Headers/parameters on which ENVs will be applied.
 * @param environment Provides ENV variables for parsing template-string.
 * @returns Active, non-empty-key, parsed headers/parameters pairs.
 */
export const getEffectiveFinalMetaData = (
  metaData: HoppRESTHeader[] | HoppRESTParam[],
  environment: Environment
) =>
  pipe(
    metaData,

    /**
     * Selecting only non-empty and active pairs.
     */
    A.filter(({ key, active }) => !S.isEmpty(key) && active),
    A.map(({ key, value }) => ({
      active: true,
      key: parseTemplateStringE(key, environment.variables),
      value: parseTemplateStringE(value, environment.variables),
    })),
    E.fromPredicate(
      /**
       * Check if every key-value is right either. Else return HoppCLIError with
       * appropriate reason.
       */
      A.every(({ key, value }) => E.isRight(key) && E.isRight(value)),
      (reason) => error({ code: "PARSING_ERROR", data: reason })
    ),
    E.map(
      /**
       * Filtering and mapping only right-eithers for each key-value as [string, string].
       */
      A.filterMap(({ key, value }) =>
        E.isRight(key) && E.isRight(value)
          ? O.some({ active: true, key: key.right, value: value.right })
          : O.none
      )
    )
  );

/**
 * Reduces array of HoppRESTParam or HoppRESTHeader to unique key-value
 * pair.
 * @param metaData Array of meta-data to reduce.
 * @returns Object with unique key-value pair.
 */
export const getMetaDataPairs = (
  metaData: HoppRESTParam[] | HoppRESTHeader[]
) =>
  pipe(
    metaData,

    // Excluding non-active & empty key request meta-data.
    A.filter(({ active, key }) => active && !S.isEmpty(key)),

    // Reducing array of request-meta-data to key-value pair object.
    A.reduce(<Record<string, string>>{}, (target, { key, value }) =>
      Object.assign(target, { [`${key}`]: value })
    )
  );

/**
 * Object providing aliases for chalk color properties based on exceptions.
 */
export const exceptionColors = {
  WARN: chalk.yellow,
  INFO: chalk.blue,
  FAIL: chalk.red,
  SUCCESS: chalk.green,
  INFO_BRIGHT: chalk.blueBright,
  BG_WARN: chalk.bgYellow,
  BG_FAIL: chalk.bgRed,
  BG_INFO: chalk.bgBlue,
  BG_SUCCESS: chalk.bgGreen,
};

/**
 * Calculates duration in seconds for given end-HRTime of format [seconds, nanoseconds],
 * which is rounded-off upto given decimal value.
 * @param end Providing end-HRTime of format [seconds, nanoseconds].
 * @param precision Decimal precision to round-off float duration value (DEFAULT = 3).
 * @returns Rounded duration in seconds for given decimal precision.
 */
export const getDurationInSeconds = (
  end: [number, number],
  precision: number = DEFAULT_DURATION_PRECISION
) => {
  const durationInSeconds = (end[0] * 1e9 + end[1]) / 1e9;
  return round(durationInSeconds, precision);
};

export const roundDuration = (
  duration: number,
  precision: number = DEFAULT_DURATION_PRECISION
) => round(duration, precision);

export const getResourceContents = async ({
  pathOrId,
  accessToken,
  serverUrl,
  resourceType,
}: {
  pathOrId: string;
  accessToken?: string;
  serverUrl?: string;
  resourceType: "collection" | "environment";
}): Promise<HoppCollection | Environment> => {
  let contents = null;
  let fileExistsInPath = false;

  try {
    await fs.access(pathOrId);
    fileExistsInPath = true;
  } catch (e) {
    fileExistsInPath = false;
  }

  if (accessToken && !fileExistsInPath) {
    try {
      const hostname = serverUrl || "https://api.hoppscotch.io";

      const separator = hostname.endsWith("/") ? "" : "/";
      const resourcePath =
        resourceType === "collection" ? "collection" : "environment";

      const url = `${hostname}${separator}v1/access-tokens/${resourcePath}/${pathOrId}`;

      const { data, headers } = await axios.get(url, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });

      if (!headers["content-type"].includes("application/json")) {
        throw new Error("INVALID_CONTENT_TYPE");
      }

      contents =
        resourceType === "collection"
          ? transformWorkspaceCollection(data as WorkspaceCollection)
          : transformWorkspaceEnvironment(data as WorkspaceEnvironment);
    } catch (err) {
      const axiosErr = err as AxiosError<{
        reason?: any;
        message: string;
        error: string;
        statusCode: number;
      }>;

      if (axiosErr.code === "ECONNREFUSED") {
        throw error({ code: "SERVER_CONNECTION_REFUSED", data: serverUrl });
      }

      if (
        axiosErr.message === "INVALID_CONTENT_TYPE" ||
        axiosErr.code === "ERR_INVALID_URL" ||
        axiosErr.code === "ENOTFOUND" ||
        axiosErr.response?.status === 404
      ) {
        throw error({ code: "INVALID_SERVER_URL", data: serverUrl });
      }

      const errReason = axiosErr.response?.data?.reason;

      if (errReason) {
        throw error({
          code: errReason,
          data: ["TOKEN_EXPIRED", "TOKEN_INVALID"].includes(errReason)
            ? accessToken
            : pathOrId,
        });
      }
    }
  }

  // Fallback to reading from file if contents are not available
  if (contents === null) {
    contents = await readJsonFile(pathOrId, fileExistsInPath);
  }

  return contents;
};

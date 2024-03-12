import { authorized } from '../../utils/gql-utils'
import {
  AddDiscoverFeedError,
  AddDiscoverFeedErrorCode,
  AddDiscoverFeedSuccess,
  DiscoverFeed,
  MutationAddDiscoverFeedArgs,
} from '../../generated/graphql'
import { appDataSource } from '../../data_source'
import { QueryRunner } from 'typeorm'
import axios from 'axios'
import { RSS_PARSER_CONFIG } from '../../utils/parser'
import { XMLParser } from 'fast-xml-parser'
import { EntityType } from '../../pubsub'
import { v4 } from 'uuid'

const parser = new XMLParser({
  ignoreAttributes: false,
  parseTagValue: true,
  ignoreDeclaration: false,
  ignorePiTags: false,
})

type DiscoverFeedRows = {
  rows: DiscoverFeed[]
}

const extractAtomData = (
  url: string,
  feed: {
    title: string
    subtitle?: string
    icon?: string
  }
): Partial<DiscoverFeed> => ({
  description: feed.subtitle ?? '',
  title: feed.title ?? url,
  image: feed.icon,
  link: url,
  type: 'atom',
})

const extractRssData = (
  url: string,
  parsedXml: {
    channel: {
      title: string
      description?: string
      ['sy:updateFrequency']: number
    }
    image: { url: string }
  }
): Partial<DiscoverFeed> => ({
  description: parsedXml.channel?.description ?? '',
  title: parsedXml.channel.title ?? url,
  image: parsedXml.image?.url,
  link: url,
  type: 'rss',
})

const handleExistingSubscription = async (
  queryRunner: QueryRunner,
  feed: DiscoverFeed,
  userId: string
): Promise<AddDiscoverFeedSuccess | AddDiscoverFeedError> => {
  // Add to existing, otherwise conflict.
  const existingSubscription = await queryRunner.query(
    'SELECT * FROM omnivore.discover_feed_subscription WHERE user_id = $1 and feed_id = $2',
    [userId, feed.id]
  )

  if (existingSubscription.rows > 1) {
    await queryRunner.release()
    return {
      __typename: 'AddDiscoverFeedError',
      errorCodes: [AddDiscoverFeedErrorCode.Conflict],
    }
  }

  const addSubscription = await queryRunner.query(
    'INSERT INTO omnivore.discover_feed_subscription(feed_id, user_id) VALUES($1, $2)',
    [feed.id, userId]
  )

  return {
    __typename: 'AddDiscoverFeedSuccess',
    feed,
  }
}

const addNewSubscription = async (
  queryRunner: QueryRunner,
  url: string,
  userId: string
): Promise<AddDiscoverFeedSuccess | AddDiscoverFeedError> => {
  // First things first, we need to validate that this is an actual RSS or ATOM feed.
  const response = await axios.get(url, RSS_PARSER_CONFIG)
  const content = response.data

  const contentType = response.headers['content-type']
  const isXML =
    contentType?.includes('text/rss+xml') ||
    contentType?.includes('text/atom+xml') ||
    contentType?.includes('application/xml')

  if (!isXML) {
    return {
      __typename: 'AddDiscoverFeedError',
      errorCodes: [AddDiscoverFeedErrorCode.BadRequest],
    }
  }
  const parsedFeed = parser.parse(content)

  if (!parsedFeed?.rss && !parsedFeed['rdf:RDF'] && !parsedFeed['feed']) {
    return {
      __typename: 'AddDiscoverFeedError',
      errorCodes: [AddDiscoverFeedErrorCode.BadRequest],
    }
  }

  const feed =
    parsedFeed?.rss || parsedFeed['rdf:RDF']
      ? extractRssData(url, parsedFeed.rss || parsedFeed['rdf:RDF'])
      : extractAtomData(url, parsedFeed.feed)

  if (!feed.title) {
    return {
      __typename: 'AddDiscoverFeedError',
      errorCodes: [AddDiscoverFeedErrorCode.BadRequest],
    }
  }

  const discoverFeedId = v4()
  await queryRunner.query(
    'INSERT INTO omnivore.discover_feed(id, title, link, image, type, description) VALUES($1, $2, $3, $4, $5, $6)',
    [
      discoverFeedId,
      feed.title,
      feed.link,
      feed.image,
      feed.type,
      feed.description,
    ]
  )

  await queryRunner.query(
    'INSERT INTO omnivore.discover_feed_subscription(feed_id, user_id) VALUES($2, $1)',
    [userId, discoverFeedId]
  )

  await queryRunner.release()
  return {
    __typename: 'AddDiscoverFeedSuccess',
    feed: { ...feed, id: discoverFeedId } as DiscoverFeed,
  }
}

export const addDiscoverFeedResolver = authorized<
  AddDiscoverFeedSuccess,
  AddDiscoverFeedError,
  MutationAddDiscoverFeedArgs
>(async (_, { input: { url } }, { uid, log, pubsub }) => {
  try {
    const queryRunner = (await appDataSource
      .createQueryRunner()
      .connect()) as QueryRunner

    const existingFeed = (await queryRunner.query(
      'SELECT id from omnivore.discover_feed where link = $1',
      [url]
    )) as DiscoverFeedRows

    if (existingFeed.rows.length > 0) {
      return await handleExistingSubscription(
        queryRunner,
        existingFeed.rows[0],
        uid
      )
    }

    const result = await addNewSubscription(queryRunner, url, uid)
    if (result.__typename == 'AddDiscoverFeedSuccess') {
      await pubsub.entityCreated(
        EntityType.RSS_FEED,
        { feed: result.feed, libraryItemId: 'NA' },
        uid
      )
    }

    return result
  } catch (error) {
    log.error('Error Getting Discover Articles', error)

    return {
      __typename: 'AddDiscoverFeedError',
      errorCodes: [AddDiscoverFeedErrorCode.Unauthorized],
    }
  }
})
